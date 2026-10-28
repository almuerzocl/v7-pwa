-- 012_security_transition_status.sql
-- Fix de seguridad (lints Supabase 2026-09-30, hallazgo CRÍTICO #1).
--
-- Problema: transition_status(p_actor_id, p_actor_role) era SECURITY DEFINER, con EXECUTE
-- para PUBLIC/anon/authenticated y confiaba ciegamente en p_actor_role. Cualquiera con la
-- anon key podía confirmar/rechazar/cancelar reservas y pedidos ajenos haciéndose pasar por
-- 'restaurant'.
--
-- Fix (defensa en profundidad):
--   1) REVOKE EXECUTE a PUBLIC/anon/authenticated. Los únicos callers legítimos son server
--      actions del PWA que usan la service_role key (status-actions.ts,
--      reservation-create-action.ts).
--   2) Dentro de la función, según el rol REAL del JWT:
--        anon          -> rechazado.
--        service_role  -> confía en p_actor_*  (caller de backend; la server action ya
--                         deriva el rol, ver status-actions.ts).
--        authenticated -> IGNORA p_actor_id; el actor es auth.uid(). El rol efectivo se deriva
--                         de la BD: 'restaurant' solo si el usuario es staff/owner de
--                         v_restaurant_id, 'customer' solo si es el dueño del registro.
--                         El p_actor_role del cliente solo sirve para elegir entre roles que
--                         el caller realmente posee; nunca puede ser 'system'.
--   Con (1) aplicado el camino 'authenticated' es inalcanzable hoy; queda como red de
--   seguridad si algún día alguien re-otorga EXECUTE.
--
-- Todo lo demás (matriz de transiciones, notificaciones) es idéntico al de producción.

CREATE OR REPLACE FUNCTION public.transition_status(
    p_table text, p_id uuid, p_new_status text, p_actor_id uuid, p_actor_role text, p_reason text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_current_status TEXT;
    v_restaurant_id UUID;
    v_customer_id UUID;
    v_timestamps JSONB;
    v_is_valid BOOLEAN := FALSE;
    v_notify_target TEXT;
    v_notify_title TEXT;
    v_notify_message TEXT;
    v_notify_priority TEXT := 'NORMAL';
    v_notify_type TEXT;
    v_restaurant_name TEXT;
    v_jwt_role TEXT;
    v_uid UUID;
    v_is_staff BOOLEAN;
    v_is_customer BOOLEAN;
BEGIN
    v_jwt_role := COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
        NULLIF(current_setting('request.jwt.claim.role', true), '')
    );

    -- Sin claims = conexión directa (SQL editor / migraciones): solo roles internos.
    IF v_jwt_role IS NULL AND session_user NOT IN ('postgres', 'supabase_admin', 'service_role') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Not authorized');
    END IF;
    IF v_jwt_role IS NOT NULL AND v_jwt_role NOT IN ('service_role', 'authenticated') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Not authorized');
    END IF;

    IF p_table = 'reservations' THEN
        SELECT status, restaurant_id, organizer_id, COALESCE(timestamps, '{}'::jsonb)
        INTO v_current_status, v_restaurant_id, v_customer_id, v_timestamps
        FROM public.reservations WHERE id = p_id FOR UPDATE;
        v_notify_type := 'RESERVATION';
    ELSIF p_table = 'takeaway_orders' THEN
        SELECT status, restaurant_id, user_id, COALESCE(timestamps, '{}'::jsonb)
        INTO v_current_status, v_restaurant_id, v_customer_id, v_timestamps
        FROM public.takeaway_orders WHERE id = p_id FOR UPDATE;
        v_notify_type := 'TAKEAWAY';
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'Invalid table: ' || p_table);
    END IF;

    IF v_current_status IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Record not found');
    END IF;

    -- Caller authenticated: identidad y rol salen de la BD, no de los parámetros.
    IF v_jwt_role = 'authenticated' THEN
        v_uid := auth.uid();
        IF v_uid IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'Not authorized');
        END IF;

        v_is_staff := EXISTS (SELECT 1 FROM public.profiles pr
                               WHERE pr.id = v_uid AND pr.restaurant_id = v_restaurant_id)
                   OR EXISTS (SELECT 1 FROM public.restaurants r
                               WHERE r.id = v_restaurant_id AND r.owner_id = v_uid);
        v_is_customer := (v_customer_id IS NOT NULL AND v_customer_id = v_uid);

        p_actor_id := v_uid;
        p_actor_role := CASE
            WHEN p_actor_role = 'customer'   AND v_is_customer THEN 'customer'
            WHEN p_actor_role = 'restaurant' AND v_is_staff    THEN 'restaurant'
            WHEN v_is_staff    THEN 'restaurant'
            WHEN v_is_customer THEN 'customer'
            ELSE NULL
        END;

        IF p_actor_role IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'Not authorized');
        END IF;
    END IF;

    IF v_current_status = p_new_status THEN
        RETURN jsonb_build_object('success', true, 'idempotent', true, 'status', v_current_status);
    END IF;

    IF p_table = 'reservations' THEN
        v_is_valid := CASE
            WHEN v_current_status = 'CREADA' AND p_new_status = 'PENDIENTE' AND p_actor_role IN ('system','customer') THEN TRUE
            WHEN v_current_status = 'PENDIENTE' AND p_new_status = 'CONFIRMADA' AND p_actor_role IN ('restaurant','system') THEN TRUE
            WHEN v_current_status = 'PENDIENTE' AND p_new_status = 'RECHAZADA' AND p_actor_role = 'restaurant' THEN TRUE
            WHEN v_current_status IN ('CREADA','PENDIENTE','CONFIRMADA') AND p_new_status = 'CANCELADA' AND p_actor_role IN ('customer','restaurant') THEN TRUE
            WHEN v_current_status = 'CONFIRMADA' AND p_new_status = 'CHECK-IN CLIENTE' AND p_actor_role = 'customer' THEN TRUE
            WHEN v_current_status = 'CHECK-IN CLIENTE' AND p_new_status = 'COMPLETADA' AND p_actor_role = 'restaurant' THEN TRUE
            WHEN v_current_status IN ('CONFIRMADA','CHECK-IN CLIENTE') AND p_new_status = 'NO_SHOW' AND p_actor_role IN ('restaurant','system') THEN TRUE
            ELSE FALSE
        END;
    ELSIF p_table = 'takeaway_orders' THEN
        v_is_valid := CASE
            WHEN v_current_status = 'CREADA' AND p_new_status = 'PENDIENTE' AND p_actor_role IN ('system','customer') THEN TRUE
            WHEN v_current_status IN ('PENDIENTE','CREADA') AND p_new_status = 'APROBADA' AND p_actor_role IN ('restaurant','system') THEN TRUE
            WHEN v_current_status IN ('PENDIENTE','CREADA') AND p_new_status = 'RECHAZADA' AND p_actor_role = 'restaurant' THEN TRUE
            WHEN v_current_status IN ('CREADA','PENDIENTE') AND p_new_status = 'CANCELADO' AND p_actor_role IN ('customer','restaurant') THEN TRUE
            WHEN v_current_status = 'APROBADA' AND p_new_status = 'PREPARANDO' AND p_actor_role = 'restaurant' THEN TRUE
            WHEN v_current_status = 'PREPARANDO' AND p_new_status = 'LISTO' AND p_actor_role = 'restaurant' THEN TRUE
            WHEN v_current_status IN ('LISTO','PREPARANDO','APROBADA') AND p_new_status = 'ENTREGADO' AND p_actor_role = 'customer' THEN TRUE
            WHEN v_current_status = 'LISTO' AND p_new_status = 'NO_RETIRADO' AND p_actor_role IN ('restaurant','system') THEN TRUE
            ELSE FALSE
        END;
    END IF;

    IF NOT v_is_valid THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', format('Transicion invalida: %s -> %s (rol: %s)', v_current_status, p_new_status, p_actor_role)
        );
    END IF;

    v_timestamps := v_timestamps || jsonb_build_object(
        p_new_status, jsonb_build_object(
            'at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'actor_id', p_actor_id::text,
            'actor_role', p_actor_role,
            'reason', COALESCE(p_reason, '')
        )
    );

    IF p_table = 'reservations' THEN
        UPDATE public.reservations SET status = p_new_status, timestamps = v_timestamps, updated_at = NOW() WHERE id = p_id;
    ELSE
        UPDATE public.takeaway_orders SET status = p_new_status, timestamps = v_timestamps, updated_at = NOW() WHERE id = p_id;
    END IF;

    SELECT name INTO v_restaurant_name FROM public.restaurants WHERE id = v_restaurant_id;
    v_restaurant_name := COALESCE(v_restaurant_name, 'Restaurante');

    IF p_actor_role = 'customer' THEN
        v_notify_target := 'restaurant';
    ELSE
        v_notify_target := 'customer';
    END IF;

    IF p_table = 'reservations' THEN
        v_notify_title := v_restaurant_name;
        v_notify_message := CASE p_new_status
            WHEN 'PENDIENTE' THEN 'Nueva reserva recibida'
            WHEN 'CONFIRMADA' THEN 'Tu reserva ha sido confirmada'
            WHEN 'RECHAZADA' THEN 'Tu reserva ha sido rechazada' || COALESCE('. Motivo: ' || p_reason, '')
            WHEN 'CANCELADA' THEN CASE WHEN p_actor_role = 'customer' THEN 'El cliente cancelo su reserva' ELSE 'Tu reserva ha sido cancelada' END
            WHEN 'CHECK-IN CLIENTE' THEN 'El cliente ha llegado al restaurante'
            WHEN 'COMPLETADA' THEN 'Gracias por tu visita'
            WHEN 'NO_SHOW' THEN 'Tu reserva fue marcada como no asistida'
            ELSE 'Estado actualizado a ' || p_new_status
        END;
    ELSE
        v_notify_title := v_restaurant_name;
        v_notify_message := CASE p_new_status
            WHEN 'PENDIENTE' THEN 'Nuevo pedido takeaway recibido'
            WHEN 'APROBADA' THEN 'Tu pedido ha sido aprobado'
            WHEN 'RECHAZADA' THEN 'Tu pedido ha sido rechazado' || COALESCE('. Motivo: ' || p_reason, '')
            WHEN 'CANCELADO' THEN CASE WHEN p_actor_role = 'customer' THEN 'El cliente cancelo su pedido' ELSE 'Tu pedido ha sido cancelado' END
            WHEN 'PREPARANDO' THEN 'Tu pedido se esta preparando'
            WHEN 'LISTO' THEN 'Tu pedido esta listo para retirar!'
            WHEN 'ENTREGADO' THEN 'El cliente confirmo la recepcion del pedido'
            WHEN 'NO_RETIRADO' THEN 'Tu pedido no fue retirado a tiempo'
            ELSE 'Estado actualizado a ' || p_new_status
        END;
    END IF;

    v_notify_priority := CASE
        WHEN p_new_status = 'PENDIENTE' THEN 'CRITICAL'
        WHEN p_new_status = 'CHECK-IN CLIENTE' THEN 'CRITICAL'
        WHEN p_new_status = 'RECHAZADA' THEN 'CRITICAL'
        WHEN p_new_status IN ('CANCELADA', 'CANCELADO') THEN 'CRITICAL'
        WHEN p_new_status = 'LISTO' THEN 'CRITICAL'
        ELSE 'NORMAL'
    END;

    IF v_notify_target = 'customer' AND v_customer_id IS NOT NULL THEN
        INSERT INTO public.notifications (user_id, restaurant_id, type, title, message, related_id, priority, actor_id, actor_role)
        VALUES (v_customer_id, v_restaurant_id, v_notify_type, v_notify_title, v_notify_message, p_id, v_notify_priority, p_actor_id, p_actor_role);
    ELSIF v_notify_target = 'restaurant' THEN
        INSERT INTO public.notifications (user_id, restaurant_id, type, title, message, related_id, priority, actor_id, actor_role)
        SELECT p.id, v_restaurant_id, v_notify_type, v_notify_title, v_notify_message, p_id, v_notify_priority, p_actor_id, p_actor_role
        FROM public.profiles p
        WHERE p.restaurant_id = v_restaurant_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'previous_status', v_current_status,
        'new_status', p_new_status,
        'notify_target', v_notify_target,
        'priority', v_notify_priority
    );
END;
$function$;

-- Solo backend (service_role). Ver comentario de cabecera.
REVOKE EXECUTE ON FUNCTION public.transition_status(text, uuid, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.transition_status(text, uuid, text, uuid, text, text) TO service_role;
