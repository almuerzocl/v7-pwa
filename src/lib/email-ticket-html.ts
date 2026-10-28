// Plantilla HTML del ticket por correo. Módulo SIN directiva: lo usan el emisor del servidor
// (reservation-confirmation.ts) y, para pedidos, notifications.ts. Todo texto de usuario se escapa.

export function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export interface NotificationGuest {
    id?: string;
    name: string;
    email?: string | null;
    status?: string;
    is_organizer?: boolean;
}

// ─── FULL TICKET EMAIL HTML BUILDER ────────────────────────────────────────────
// Faithfully reproduces the TicketDigital component design as inline-style HTML
// compatible with all major email clients.
export function buildTicketEmailHtml(params: {
    type: 'reservation' | 'order';
    restaurantName: string;
    restaurantAddress?: string;
    ticketCode: string;
    displayDate: string;
    displayTime: string;
    partySize?: number;
    itemCount?: number;
    totalAmount?: number;
    guests?: NotificationGuest[];
    ticketUrl: string;
    recipientFirstName: string;
    isPersonalInvite: boolean;
    organizerName?: string;
    rsvpConfirmUrl?: string;
    rsvpCancelUrl?: string;
    calendarGoogleUrl?: string;
    currentStep?: number;
    /** Detalle del pedido con las opciones elegidas; solo se pasa cuando algún plato tiene opciones (el correo no cambia si no). */
    orderLines?: Array<{ quantity: number; name: string; options: string[] }>;
}): string {
    const {
        type,
        ticketCode,
        displayDate,
        displayTime,
        partySize,
        itemCount,
        totalAmount,
        guests,
        ticketUrl,
        isPersonalInvite,
        rsvpConfirmUrl,
        rsvpCancelUrl,
        calendarGoogleUrl,
        currentStep = type === 'reservation' ? 2 : 1,
    } = params;

    const restaurantName = escapeHtml(params.restaurantName);
    const restaurantAddress = params.restaurantAddress ? escapeHtml(params.restaurantAddress) : undefined;
    const recipientFirstName = escapeHtml(params.recipientFirstName);
    const organizerName = params.organizerName ? escapeHtml(params.organizerName) : undefined;
    const isOrder = type === 'order';
    const steps = isOrder
        ? ['Pedido', 'Preparando', 'Listo', 'Entregado']
        : ['Solicitada', 'Pendiente', 'Confirmada', 'Completada'];

    const greeting = isPersonalInvite
        ? `Hola ${recipientFirstName}. Has sido invitado a almorzar${organizerName ? ` con ${organizerName}` : ''} en ${restaurantName}.`
        : isOrder
            ? `Hola ${recipientFirstName}. Tu pedido está confirmado.`
            : `Hola ${recipientFirstName}. Tu reserva está confirmada.`;

    const statusLabel = isOrder ? 'RECIBIDO' : 'CONFIRMADA';

    const orderLinesHtml = isOrder && params.orderLines && params.orderLines.length > 0
        ? `<table width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px 0;border-top:1px solid #e2e8f0;">
                <tr><td style="padding:12px 0 6px 0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;">Tu pedido</td></tr>
                ${params.orderLines.map((l) => `<tr><td style="padding:4px 0;font-size:13px;color:#0f172a;"><strong>${l.quantity}&times; ${escapeHtml(l.name)}</strong>${l.options.length > 0 ? `<br><span style="font-size:12px;color:#64748b;">${escapeHtml(l.options.join(', '))}</span>` : ''}</td></tr>`).join('')}
            </table>`
        : '';

    const quantityDisplay = isOrder
        ? (totalAmount ? `$${totalAmount.toLocaleString('es-CL')}` : `${itemCount ?? 0} Items`)
        : `${partySize ?? 0} Personas`;

    // ── Timeline dots ──
    const stepPct = steps.length > 1 ? (currentStep / (steps.length - 1)) * 100 : 0;
    const timelineHtml = `
    <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:28px;">
        <tr><td style="padding-bottom:10px;text-align:center;">
            <p style="margin:0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:#94a3b8;">Tracking de Estado</p>
        </td></tr>
        <tr><td>
            <table width="100%" cellspacing="0" cellpadding="0">
                <tr>
                    ${steps.map((step, i) => {
                        const isCurrent = i === currentStep;
                        const isDone = i < currentStep;
                        const dotBg = isCurrent ? '#f97316' : isDone ? '#fdba74' : '#e2e8f0';
                        const labelColor = isCurrent ? '#f97316' : isDone ? '#fb923c' : '#94a3b8';
                        const ring = isCurrent ? 'outline:4px solid rgba(249,115,22,0.15);outline-offset:2px;' : '';
                        return `<td style="text-align:center;vertical-align:top;width:${100 / steps.length}%;">
                            <div style="width:14px;height:14px;border-radius:50%;background:${dotBg};margin:0 auto;${ring}"></div>
                            <p style="margin:6px 0 0 0;font-size:9px;font-weight:800;text-transform:uppercase;color:${labelColor};letter-spacing:0.5px;">${step}</p>
                        </td>`;
                    }).join('')}
                </tr>
            </table>
            <div style="height:3px;background:linear-gradient(to right,#f97316 ${stepPct}%,#e2e8f0 ${stepPct}%);border-radius:2px;margin-top:-16px;"></div>
        </td></tr>
        <tr><td style="height:20px;"></td></tr>
    </table>`;

    // ── Guest list ──
    const guestListHtml = (guests && guests.length > 0) ? `
    <table width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #f1f5f9;margin:4px 0 20px 0;">
        <tr><td style="padding:16px 0 10px 0;">
            <table width="100%" cellspacing="0" cellpadding="0"><tr>
                <td><p style="margin:0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:#94a3b8;">Invitados y Asistencia</p></td>
                <td style="text-align:right;"><span style="background:#0f172a;color:#fff;font-size:9px;font-weight:800;text-transform:uppercase;padding:4px 10px;border-radius:99px;">${guests.length} TOTAL</span></td>
            </tr></table>
        </td></tr>
        ${guests.map(g => {
            const name = escapeHtml(g.name || 'Invitado');
            const status = (g.status || 'PENDIENTE').toUpperCase();
            const initials = name.split(' ').map((n: string) => n[0] || '').join('').toUpperCase().slice(0, 2);
            const statusBg = status === 'CONFIRMADA' ? '#dcfce7' : status === 'CANCELADA' ? '#fee2e2' : '#fef9c3';
            const statusColor = status === 'CONFIRMADA' ? '#15803d' : status === 'CANCELADA' ? '#dc2626' : '#a16207';
            const avatarBg = g.is_organizer ? '#0f172a' : '#f8fafc';
            const avatarColor = g.is_organizer ? '#fff' : '#64748b';
            const hostBadge = g.is_organizer
                ? `&nbsp;<span style="font-size:8px;background:#f97316;color:white;padding:1px 6px;border-radius:4px;font-weight:900;text-transform:uppercase;font-style:italic;">Host</span>`
                : '';
            return `
        <tr><td style="padding:10px 0;border-bottom:1px solid #f8fafc;">
            <table width="100%" cellspacing="0" cellpadding="0"><tr>
                <td style="width:40px;vertical-align:middle;">
                    <div style="width:36px;height:36px;background:${avatarBg};border-radius:10px;text-align:center;line-height:36px;font-size:12px;font-weight:900;color:${avatarColor};">${initials}</div>
                </td>
                <td style="padding-left:12px;vertical-align:middle;">
                    <p style="margin:0 0 2px 0;font-size:13px;font-weight:800;color:#0f172a;">${name}${hostBadge}</p>
                    ${g.email ? `<p style="margin:0;font-size:10px;color:#94a3b8;font-weight:600;">${escapeHtml(g.email)}</p>` : ''}
                </td>
                <td style="text-align:right;white-space:nowrap;vertical-align:middle;">
                    <span style="background:${statusBg};color:${statusColor};font-size:9px;font-weight:800;text-transform:uppercase;padding:4px 10px;border-radius:99px;">${status}</span>
                </td>
            </tr></table>
        </td></tr>`;
        }).join('')}
    </table>` : '';

    // ── RSVP buttons ──
    const rsvpHtml = (rsvpConfirmUrl && rsvpCancelUrl) ? `
    <table width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:20px;margin-bottom:16px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
        <tr><td style="padding:20px 24px 12px 24px;text-align:center;">
            <p style="margin:0;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:#64748b;">&#xBF;Confirmas tu asistencia?</p>
        </td></tr>
        <tr><td style="padding:0 24px 20px 24px;">
            <table width="100%" cellspacing="0" cellpadding="0"><tr>
                <td style="width:50%;padding-right:8px;">
                    <a href="${rsvpConfirmUrl}" style="display:block;background-color:#16a34a;color:#ffffff;padding:16px;text-decoration:none;border-radius:14px;font-weight:900;text-transform:uppercase;letter-spacing:1px;font-size:13px;text-align:center;">&#x2713; Confirmar</a>
                </td>
                <td style="width:50%;padding-left:8px;">
                    <a href="${rsvpCancelUrl}" style="display:block;background-color:#fef2f2;color:#dc2626;padding:16px;text-decoration:none;border-radius:14px;font-weight:900;text-transform:uppercase;letter-spacing:1px;font-size:13px;text-align:center;border:2px solid #fecaca;">&#x2715; No puedo ir</a>
                </td>
            </tr></table>
        </td></tr>
    </table>` : '';

    // ── Calendar buttons ──
    const calendarHtml = calendarGoogleUrl ? `
    <table width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:20px;margin-bottom:20px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
        <tr><td style="padding:20px 24px;text-align:center;">
            <p style="margin:0 0 14px 0;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:#64748b;">Importar a mi calendario</p>
            <table cellspacing="0" cellpadding="0" style="margin:0 auto;"><tr>
                <td style="padding-right:8px;">
                    <a href="${calendarGoogleUrl}" style="display:inline-block;background:#f8fafc;color:#0f172a;padding:14px 22px;text-decoration:none;border-radius:14px;font-weight:800;font-size:12px;border:2px solid #e2e8f0;">&#128197; Google Calendar</a>
                </td>
                <td>
                    <a href="${ticketUrl}" style="display:inline-block;background:#f8fafc;color:#0f172a;padding:14px 22px;text-decoration:none;border-radius:14px;font-weight:800;font-size:12px;border:2px solid #e2e8f0;">&#127822; Apple / ICS</a>
                </td>
            </tr></table>
        </td></tr>
    </table>` : '';

    return `
<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 16px;background-color:#f1f5f9;color:#1a1a1a;">

    <!-- Almuerzo.cl wordmark -->
    <div style="text-align:center;margin-bottom:20px;">
        <span style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:4px;color:#64748b;">Almuerzo.cl</span>
    </div>

    <!-- Greeting -->
    <p style="font-size:15px;font-weight:700;color:#334155;text-align:center;margin:0 0 20px 0;line-height:1.6;">${greeting}</p>

    <!-- TICKET CARD -->
    <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;background:#ffffff;border-radius:28px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.12);margin-bottom:20px;">
    <tbody>

        <!-- ORANGE HEADER -->
        <tr><td style="background-color:#f97316;padding:32px 28px 28px 28px;border-radius:28px 28px 0 0;">
            <table width="100%" cellspacing="0" cellpadding="0"><tr>
                <td>
                    <p style="margin:0 0 3px 0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:rgba(255,255,255,0.65);">Restaurante</p>
                    <h2 style="margin:0;font-size:24px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;line-height:1.1;">${restaurantName}</h2>
                </td>
                <td style="text-align:right;vertical-align:top;padding-left:12px;white-space:nowrap;">
                    <span style="display:inline-block;background:rgba(255,255,255,0.25);padding:8px 10px;border-radius:12px;font-size:18px;line-height:1;">&#127915;</span>
                </td>
            </tr></table>
            <table width="100%" cellspacing="0" cellpadding="0" style="margin-top:28px;"><tr>
                <td style="vertical-align:bottom;">
                    <p style="margin:0 0 2px 0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:rgba(255,255,255,0.65);">${isOrder ? 'C&#243;digo de Pedido' : 'C&#243;digo de Reserva'}</p>
                    <p style="margin:0;font-size:48px;font-weight:900;font-style:italic;color:#ffffff;letter-spacing:-1px;font-family:Georgia,'Times New Roman',serif;line-height:1;">${ticketCode}</p>
                </td>
                <td style="text-align:right;vertical-align:bottom;padding-left:12px;">
                    <p style="margin:0 0 2px 0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,0.65);">Estado</p>
                    <p style="margin:0;font-size:15px;font-weight:900;color:#ffffff;text-transform:uppercase;white-space:nowrap;">${statusLabel}</p>
                </td>
            </tr></table>
        </td></tr>

        <!-- PERFORATION NOTCH DIVIDER -->
        <tr><td style="padding:0;line-height:0;font-size:0;">
            <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr>
                <td style="width:16px;background-color:#f97316;height:24px;font-size:0;line-height:0;">&nbsp;</td>
                <td style="width:24px;background-color:#f1f5f9;border-radius:0 0 50% 50%;height:24px;font-size:0;line-height:0;">&nbsp;</td>
                <td style="border-top:2px dashed #cbd5e1;background-color:#ffffff;height:24px;font-size:0;line-height:0;">&nbsp;</td>
                <td style="width:24px;background-color:#f1f5f9;border-radius:0 0 50% 50%;height:24px;font-size:0;line-height:0;">&nbsp;</td>
                <td style="width:16px;background-color:#f97316;height:24px;font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
        </td></tr>

        <!-- WHITE BODY -->
        <tr><td style="background-color:#ffffff;padding:28px 28px 24px 28px;border-radius:0 0 28px 28px;">

            ${timelineHtml}

            <!-- INFO GRID -->
            <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
                <tr>
                    <td style="width:50%;padding:0 10px 16px 0;vertical-align:top;">
                        <table cellspacing="0" cellpadding="0"><tr>
                            <td style="background:#f8fafc;padding:10px;border-radius:12px;vertical-align:middle;font-size:16px;">&#128197;</td>
                            <td style="padding-left:12px;vertical-align:middle;">
                                <p style="margin:0 0 2px 0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;">${isOrder ? 'Pedido el' : 'Fecha'}</p>
                                <p style="margin:0;font-size:13px;font-weight:900;color:#0f172a;">${displayDate}</p>
                            </td>
                        </tr></table>
                    </td>
                    <td style="width:50%;padding:0 0 16px 10px;vertical-align:top;">
                        <table cellspacing="0" cellpadding="0"><tr>
                            <td style="background:#f8fafc;padding:10px;border-radius:12px;vertical-align:middle;font-size:16px;">&#128336;</td>
                            <td style="padding-left:12px;vertical-align:middle;">
                                <p style="margin:0 0 2px 0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;">Hora</p>
                                <p style="margin:0;font-size:13px;font-weight:900;color:#0f172a;">${displayTime}</p>
                            </td>
                        </tr></table>
                    </td>
                </tr>
                <tr>
                    <td style="width:50%;padding:0 10px 0 0;vertical-align:top;">
                        <table cellspacing="0" cellpadding="0"><tr>
                            <td style="background:#f8fafc;padding:10px;border-radius:12px;vertical-align:middle;font-size:16px;">${isOrder ? '&#128176;' : '&#128101;'}</td>
                            <td style="padding-left:12px;vertical-align:middle;">
                                <p style="margin:0 0 2px 0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;">${isOrder ? 'Monto' : 'Personas'}</p>
                                <p style="margin:0;font-size:13px;font-weight:900;color:#0f172a;">${quantityDisplay}</p>
                            </td>
                        </tr></table>
                    </td>
                    <td style="width:50%;padding:0 0 0 10px;vertical-align:top;">
                        <table cellspacing="0" cellpadding="0"><tr>
                            <td style="background:#f8fafc;padding:10px;border-radius:12px;vertical-align:middle;font-size:16px;">&#128205;</td>
                            <td style="padding-left:12px;vertical-align:middle;">
                                <p style="margin:0 0 2px 0;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;">Ubicaci&#243;n</p>
                                <p style="margin:0;font-size:13px;font-weight:900;color:#0f172a;">${restaurantAddress || restaurantName}</p>
                            </td>
                        </tr></table>
                    </td>
                </tr>
            </table>

            ${orderLinesHtml}

            ${guestListHtml}

            <!-- PRESENT TICKET NOTE -->
            <p style="text-align:center;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:#94a3b8;margin:16px 0 20px 0;">Presenta este ticket al llegar</p>

            <!-- VIEW TICKET BUTTON -->
            <div style="text-align:center;">
                <a href="${ticketUrl}" style="display:inline-block;background-color:#0f172a;color:#ffffff;padding:16px 36px;text-decoration:none;border-radius:14px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;font-size:12px;">Ver Ticket Digital Completo &#8594;</a>
            </div>

        </td></tr>
    </tbody>
    </table>

    ${rsvpHtml}

    ${calendarHtml}

    <!-- ARRIVAL NOTES -->
    <table width="100%" cellspacing="0" cellpadding="0" style="background:#fff7ed;border-radius:20px;margin-bottom:20px;border:1px solid #fed7aa;">
        <tr><td style="padding:20px 24px;">
            <table cellspacing="0" cellpadding="0"><tr>
                <td style="padding-right:12px;vertical-align:top;font-size:18px;line-height:1.3;">&#9200;</td>
                <td>
                    <p style="margin:0 0 6px 0;font-size:13px;font-weight:900;color:#c2410c;">${isOrder ? 'Notas de retiro' : 'Notas de llegada'}</p>
                    <p style="margin:0;font-size:12px;color:#9a3412;font-weight:500;line-height:1.6;">${isOrder
                        ? 'Tu pedido estar&#225; listo en la hora indicada. Por favor ret&#237;ralo pronto para disfrutarlo caliente.'
                        : 'Recuerda llegar puntual. Las mesas se liberan despu&#233;s de 15 minutos de retraso. Si no asistes, tu reputaci&#243;n bajar&#225; autom&#225;ticamente.'
                    }</p>
                </td>
            </tr></table>
        </td></tr>
    </table>

    <!-- FOOTER -->
    <p style="font-size:11px;color:#94a3b8;text-align:center;line-height:1.8;margin:0;">
        Accede a tu ticket digital: <a href="${ticketUrl}" style="color:#f97316;font-weight:700;text-decoration:none;">${ticketUrl}</a><br>
        &copy; ${new Date().getFullYear()} Almuerzo.cl
    </p>

</div>`;
}
