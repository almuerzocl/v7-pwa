'use client';

import { Capacitor } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();
export const isIOS = () => Capacitor.getPlatform() === 'ios';

export async function initCapacitor() {
  if (!isNative()) return;

  const { SplashScreen } = await import('@capacitor/splash-screen');
  const { StatusBar, Style } = await import('@capacitor/status-bar');
  const { Keyboard } = await import('@capacitor/keyboard');

  // Hide splash screen once app is loaded
  await SplashScreen.hide();

  // Configure status bar
  if (isIOS()) {
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setOverlaysWebView({ overlay: true });
  }

  // Keyboard behavior
  Keyboard.addListener('keyboardWillShow', () => {
    document.body.classList.add('keyboard-open');
  });
  Keyboard.addListener('keyboardWillHide', () => {
    document.body.classList.remove('keyboard-open');
  });
}
