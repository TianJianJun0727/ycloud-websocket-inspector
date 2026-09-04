import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
    srcDir: 'src',
    modules: ['@wxt-dev/module-react'],
    manifest: {
        name: '__MSG_extensionName__',
        version: '0.0.1',
        description: '__MSG_extensionDescription__',
        default_locale: 'en',
        minimum_chrome_version: '125',
        permissions: ['debugger', 'tabs'],
        action: {
            default_title: '__MSG_actionTitle__',
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
