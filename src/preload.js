/**
 * Panele yalnızca iki şey açılır: masaüstünde çalıştığını bilmesi
 * (kurulum çağrısını gizlemek için) ve çevrimdışı ekranındaki "tekrar dene".
 * Node API'leri ASLA sızdırılmaz.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motofullDesktop', {
  isDesktop: true,
  platform: process.platform,
  retry: () => ipcRenderer.send('motofull:retry'),
});
