import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
    srcDir: 'src',
    modules: ['@wxt-dev/module-react'],
    manifest: {
        name: 'YCloud WebSocket 监听器',
        version: '0.6.6',
        description: '监听 SharedWorker WebSocket 消息。',
        minimum_chrome_version: '125',
        permissions: ['debugger', 'tabs'],
        action: {
            default_title: '打开 YCloud WebSocket 监听器',
            default_icon: {
                16: 'assets/icon-16.png',
                32: 'assets/icon-32.png',
            },
        },
        icons: {
            16: 'assets/icon-16.png',
            32: 'assets/icon-32.png',
            48: 'assets/icon-48.png',
            128: 'assets/icon-128.png',
        },
    },
    vite: () => ({
        plugins: [tailwindcss()],
    }),
});
