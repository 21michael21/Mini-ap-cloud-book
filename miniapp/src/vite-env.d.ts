/// <reference types="vite/client" />

declare module "foliate-js/view.js";

interface Window {
  Telegram?: {
    WebApp?: {
      initData: string;
      ready: () => void;
      expand: () => void;
      colorScheme?: "light" | "dark";
    };
  };
}
