"use client";

import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Clock, AlertCircle, X } from "lucide-react";
import { useEffect } from "react";

interface BlockingToastProps {
    isOpen: boolean;
    title: string;
    message: string;
    type: 'success' | 'loading' | 'error';
    onClose?: () => void;
}

export function BlockingToast({ isOpen, title, message, type, onClose }: BlockingToastProps) {

    // Auto-close success after 3 seconds if no manual close provided
    useEffect(() => {
        if (isOpen && type === 'success' && onClose) {
            const timer = setTimeout(onClose, 3000);
            return () => clearTimeout(timer);
        }
    }, [isOpen, type, onClose]);

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[30000] flex items-center justify-center p-6 bg-background/40 backdrop-blur-sm">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        className="bg-card w-full max-w-sm rounded-[2.5rem] shadow-2xl border border-border/50 p-8 text-center space-y-4 ring-1 ring-black/5"
                    >
                        <div className="flex justify-center">
                            {type === 'success' && (
                                <div className="bg-green-500/10 p-4 rounded-full">
                                    <CheckCircle2 className="w-12 h-12 text-green-500 animate-in zoom-in duration-500" />
                                </div>
                            )}
                            {type === 'loading' && (
                                <div className="bg-primary/10 p-4 rounded-full">
                                    <Clock className="w-12 h-12 text-primary animate-pulse" />
                                </div>
                            )}
                            {type === 'error' && (
                                <div className="bg-destructive/10 p-4 rounded-full">
                                    <AlertCircle className="w-12 h-12 text-destructive" />
                                </div>
                            )}
                        </div>

                        <div className="space-y-1">
                            <h3 className="text-xl font-black tracking-tight text-foreground">{title}</h3>
                            <p className="text-sm text-muted-foreground font-medium">{message}</p>
                        </div>

                        {type !== 'loading' && (
                            <button
                                onClick={onClose}
                                className="mt-4 w-full h-12 bg-muted hover:bg-muted/80 rounded-2xl font-bold transition-colors flex items-center justify-center gap-2"
                            >
                                <X className="w-4 h-4" />
                                Cerrar
                            </button>
                        )}
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
