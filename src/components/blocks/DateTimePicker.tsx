'use client';

import { useState, useMemo } from 'react';
import {
    format, addDays, startOfToday, isSameDay,
    startOfMonth, endOfMonth, eachDayOfInterval,
    getDay, addMonths, subMonths, isBefore
} from 'date-fns';
import { es } from 'date-fns/locale';
import { toZonedTime } from 'date-fns-tz';
import { TIMEZONE } from '@/lib/config';
import { Calendar, Clock, ChevronLeft, ChevronRight } from 'lucide-react';

interface DateTimePickerProps {
    onSelect: (date: Date, time: string) => void;
    selectedDate?: Date;
    selectedTime?: string;
    operatingHours?: any[];
    availability?: { time: string; available: boolean; occupied: number; totalCapacity: number }[];
    /** El local atiende ese día pero no recibe reservas (ventana de reservas). */
    noReservations?: boolean;
}

export default function DateTimePicker({ onSelect, selectedDate, selectedTime, availability, noReservations }: DateTimePickerProps) {
    const today = startOfToday();
    const maxDate = addDays(today, 13);

    const [currentDate, setCurrentDate] = useState(selectedDate || today);
    const [viewMonth, setViewMonth] = useState(selectedDate || today);
    const [open, setOpen] = useState<'date' | 'time' | null>(null);

    const timeSlots = useMemo((): string[] | null => {
        if (availability === undefined) return null; // still loading — show skeleton
        if (availability.length === 0) return [];    // restaurant closed
        return availability.map(a => a.time);
    }, [availability]);

    const getSantiagoNow = () => toZonedTime(new Date(), TIMEZONE);

    // Calendar grid for the viewed month (only show valid days = today..today+13)
    const calendarDays = useMemo(() => {
        const start = startOfMonth(viewMonth);
        const end = endOfMonth(viewMonth);
        const days = eachDayOfInterval({ start, end });
        // leading blanks
        const leadingBlanks = Array.from({ length: (getDay(start) + 6) % 7 }, () => null);
        return [...leadingBlanks, ...days];
    }, [viewMonth]);

    const handleDateClick = (date: Date) => {
        setCurrentDate(date);
        onSelect(date, selectedTime || '');
        setOpen('time'); // auto-advance to time picker
    };

    const handleTimeClick = (time: string) => {
        onSelect(currentDate, time);
        setOpen(null);
    };

    const togglePanel = (panel: 'date' | 'time') => {
        setOpen(prev => prev === panel ? null : panel);
    };

    const canGoBack = !isSameDay(startOfMonth(viewMonth), startOfMonth(today));
    const canGoForward = isBefore(startOfMonth(viewMonth), startOfMonth(maxDate));

    return (
        <div className="space-y-2">
            {/* ── Trigger chips ── */}
            <div className="grid grid-cols-2 gap-2">
                <button
                    onClick={() => togglePanel('date')}
                    className={`flex items-center gap-2 px-3 h-11 rounded-2xl border text-sm font-bold transition-all ${
                        open === 'date'
                            ? 'border-primary bg-primary/5 text-primary'
                            : 'border-border bg-muted/40 text-foreground hover:border-primary/40'
                    }`}
                >
                    <Calendar className="w-4 h-4 shrink-0 text-primary/70" />
                    <span className="truncate">
                        {selectedDate
                            ? format(selectedDate, "eee d MMM", { locale: es })
                            : 'Fecha'}
                    </span>
                </button>

                <button
                    onClick={() => togglePanel('time')}
                    className={`flex items-center gap-2 px-3 h-11 rounded-2xl border text-sm font-bold transition-all ${
                        open === 'time'
                            ? 'border-primary bg-primary/5 text-primary'
                            : 'border-border bg-muted/40 text-foreground hover:border-primary/40'
                    }`}
                >
                    <Clock className="w-4 h-4 shrink-0 text-primary/70" />
                    <span className="truncate">{selectedTime || 'Hora'}</span>
                </button>
            </div>

            {/* ── Calendar panel ── */}
            {open === 'date' && (
                <div className="border border-border rounded-2xl bg-background p-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
                    {/* Month nav */}
                    <div className="flex items-center justify-between">
                        <button onClick={() => canGoBack && setViewMonth(subMonths(viewMonth, 1))}
                            disabled={!canGoBack}
                            className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-xs font-black uppercase tracking-wider text-foreground">
                            {format(viewMonth, 'MMMM yyyy', { locale: es })}
                        </span>
                        <button onClick={() => canGoForward && setViewMonth(addMonths(viewMonth, 1))}
                            disabled={!canGoForward}
                            className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors">
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Weekday headers */}
                    <div className="grid grid-cols-7 text-center">
                        {['L','M','X','J','V','S','D'].map(d => (
                            <span key={d} className="text-xs font-black text-muted-foreground uppercase py-1">{d}</span>
                        ))}
                    </div>

                    {/* Day grid */}
                    <div className="grid grid-cols-7 gap-0.5">
                        {calendarDays.map((day, i) => {
                            if (!day) return <div key={`blank-${i}`} />;
                            const isInRange = !isBefore(day, today) && !isBefore(maxDate, day);
                            const isSelected = isSameDay(day, currentDate);
                            const isToday = isSameDay(day, today);
                            return (
                                <button
                                    key={day.toISOString()}
                                    onClick={() => isInRange && handleDateClick(day)}
                                    disabled={!isInRange}
                                    className={`h-8 w-full rounded-lg text-xs font-bold transition-all ${
                                        isSelected
                                            ? 'bg-primary text-white shadow-sm'
                                            : isToday && isInRange
                                                ? 'border border-primary/40 text-primary'
                                                : isInRange
                                                    ? 'hover:bg-muted text-foreground'
                                                    : 'text-muted-foreground/30 cursor-not-allowed'
                                    }`}
                                >
                                    {format(day, 'd')}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ── Time slots panel ── */}
            {open === 'time' && (
                <div className="border border-border rounded-2xl bg-background p-3 animate-in fade-in slide-in-from-top-1 duration-150">
                    {timeSlots === null ? (
                        <div className="grid grid-cols-5 gap-1.5">
                            {Array.from({ length: 10 }).map((_, i) => (
                                <div key={i} className="h-8 rounded-lg bg-muted animate-pulse" />
                            ))}
                        </div>
                    ) : timeSlots.length > 0 ? (
                        <div className="grid grid-cols-5 gap-1.5">
                            {timeSlots.map((time) => {
                                const [hours, minutes] = time.split(':').map(Number);
                                const slotDate = new Date(currentDate);
                                slotDate.setHours(hours, minutes, 0, 0);
                                const santiagoNow = getSantiagoNow();
                                const isPast = isSameDay(currentDate, santiagoNow) && slotDate < santiagoNow;
                                const slotAvail = availability?.find(a => a.time === time);
                                const isFull = slotAvail && !slotAvail.available;
                                const isDisabled = isPast || !!isFull;
                                const isSelected = selectedTime === time;

                                return (
                                    <button
                                        key={time}
                                        onClick={() => !isDisabled && handleTimeClick(time)}
                                        disabled={isDisabled}
                                        className={`h-8 rounded-lg text-xs font-bold border transition-all ${
                                            isSelected
                                                ? 'bg-primary border-primary text-white shadow-sm shadow-primary/30'
                                                : isDisabled
                                                    ? 'bg-muted/20 border-border text-muted-foreground/30 cursor-not-allowed line-through'
                                                    : 'bg-muted/40 border-border text-foreground hover:border-primary/40 hover:bg-muted/70'
                                        }`}
                                    >
                                        {time}
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="py-4 text-center">
                            <p className="text-xs font-bold text-muted-foreground">
                                {noReservations ? 'Este día el local no recibe reservas' : 'Restaurante cerrado este día'}
                            </p>
                            <p className="text-xs text-muted-foreground/60 mt-0.5">
                                {noReservations ? 'Está abierto: puedes ir sin reserva, o prueba con otra fecha' : 'Prueba con otra fecha'}
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
