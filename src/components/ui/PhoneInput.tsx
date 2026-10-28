'use client';

import { forwardRef, useCallback } from 'react';
import { cn } from '@/lib/utils';

// Accepts any raw input and returns the canonical masked form: +56 9 XXXX XXXX
// Works with paste, autofill, and manual typing.
export function formatChileanPhone(raw: string): string {
    let digits = raw.replace(/\D/g, '');

    // Strip known prefix variants so pasting +56912345678 / 912345678 / 12345678 all work
    if (digits.startsWith('569'))      digits = digits.slice(3);
    else if (digits.startsWith('56'))  digits = digits.slice(2);
    else if (digits.startsWith('9') && digits.length > 8) digits = digits.slice(1);

    digits = digits.slice(0, 8); // at most 8 variable digits

    if (digits.length === 0) return '';
    if (digits.length <= 4)  return `+56 9 ${digits}`;
    return `+56 9 ${digits.slice(0, 4)} ${digits.slice(4)}`;
}

const PREFIX = '+56 9 ';

interface PhoneInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type'> {
    value: string;
    onChange: (value: string) => void;
    className?: string;
}

const PhoneInput = forwardRef<HTMLInputElement, PhoneInputProps>(
    ({ value, onChange, className, onFocus, onBlur, onKeyDown, ...props }, ref) => {

        const handleChange = useCallback(
            (e: React.ChangeEvent<HTMLInputElement>) => {
                onChange(formatChileanPhone(e.target.value));
            },
            [onChange],
        );

        const handleKeyDown = useCallback(
            (e: React.KeyboardEvent<HTMLInputElement>) => {
                const input = e.currentTarget;
                // Prevent backspace/delete from eating into the fixed prefix
                if (
                    (e.key === 'Backspace' || e.key === 'Delete') &&
                    input.selectionStart !== null &&
                    input.selectionEnd !== null &&
                    input.selectionStart === input.selectionEnd &&
                    input.selectionStart <= PREFIX.length
                ) {
                    e.preventDefault();
                }
                onKeyDown?.(e);
            },
            [onKeyDown],
        );

        const handleFocus = useCallback(
            (e: React.FocusEvent<HTMLInputElement>) => {
                if (!value) onChange(PREFIX);
                // Move cursor past prefix on focus
                setTimeout(() => {
                    const len = e.target.value.length;
                    e.target.setSelectionRange(len, len);
                }, 0);
                onFocus?.(e);
            },
            [value, onChange, onFocus],
        );

        const handleBlur = useCallback(
            (e: React.FocusEvent<HTMLInputElement>) => {
                // If user left only the prefix with no digits, clear the field
                if (value === PREFIX || value === PREFIX.trimEnd()) onChange('');
                onBlur?.(e);
            },
            [value, onChange, onBlur],
        );

        return (
            <input
                {...props}
                ref={ref}
                type="tel"
                inputMode="numeric"
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onFocus={handleFocus}
                onBlur={handleBlur}
                placeholder="+56 9 1234 5678"
                className={cn(
                    // Match the shadcn/ui Input base styles
                    'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
                    'ring-offset-background placeholder:text-muted-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    className,
                )}
            />
        );
    },
);

PhoneInput.displayName = 'PhoneInput';
export default PhoneInput;
