// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // User site (devedux.github.io). El blog vive en la ruta /blog.
  // No usamos `base` porque es un user site, no un project site.
  site: 'https://devedux.github.io',
  integrations: [react(), mdx()],
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    shikiConfig: {
      // Doble tema para light/dark. defaultColor:false emite variables CSS
      // que controlamos manualmente según la clase .dark (ver global.css).
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      defaultColor: false,
    },
  },
});
