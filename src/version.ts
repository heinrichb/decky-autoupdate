declare const __PLUGIN_VERSION__: string;
export const PLUGIN_VERSION: string = typeof __PLUGIN_VERSION__ !== "undefined" ? __PLUGIN_VERSION__ : "dev";
