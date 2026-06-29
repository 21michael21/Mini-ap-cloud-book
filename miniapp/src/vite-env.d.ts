/// <reference types="vite/client" />

declare module "foliate-js/view.js";
declare module "foliate-js/epub.js";
declare module "foliate-js/fb2.js";
declare module "foliate-js/vendor/zip.js";

interface Window {
  Telegram?: {
    WebApp?: {
      initData: string;
      ready: () => void;
      expand: () => void;
      close?: () => void;
      colorScheme?: "light" | "dark";
      HapticFeedback?: {
        impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
        notificationOccurred: (type: "error" | "success" | "warning") => void;
        selectionChanged: () => void;
      };
    };
  };
}
