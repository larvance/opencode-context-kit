// Minimal stand-in for the runtime's plugin module. The real Plugin.define
// returns the plugin object; the adapter only relies on that identity.
export const Plugin = {
  define: (plugin) => plugin,
}
