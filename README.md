# devedux.github.io

Blog personal — *Aprendiendo AI Engineering en público*. De frontend engineer a AI engineer, documentando el camino.

## Stack

- **[Astro](https://astro.build)** — sitio estático, cero JS por defecto
- **[React](https://react.dev)** — islands para interactividad (theme toggle)
- **[Tailwind CSS](https://tailwindcss.com)** v4 — estilos
- **[MDX](https://mdxjs.com)** — posts con componentes
- **Shiki** — syntax highlighting (dual light/dark)
- **GitHub Pages + Actions** — hosting y CI/CD

## Desarrollo

```bash
pnpm install     # instala dependencias
pnpm dev         # servidor local en http://localhost:4321
pnpm build       # build de producción a ./dist
pnpm preview     # previsualiza el build
```

## Escribir un post

Crear un `.md` (o `.mdx`) en `src/content/blog/`:

```md
---
title: "Título del post"
description: "Resumen corto (aparece en listados y meta)."
pubDate: 2026-07-20
tags: ["tag1", "tag2"]
draft: false
---

Contenido en Markdown...
```

- `draft: true` → no se publica (útil para borradores).
- La URL será `/blog/nombre-del-archivo`.

## Deploy

Cada `git push` a `main` dispara el workflow de GitHub Actions
(`.github/workflows/deploy.yml`), que buildea y publica a GitHub Pages.

> **Setup único en GitHub:** Settings → Pages → Source: **GitHub Actions**.

## Estructura

```
src/
├── content/blog/       posts (.md / .mdx)
├── content.config.ts   schema del frontmatter
├── layouts/            BaseLayout, BlogPost
├── pages/              index, blog/index, blog/[...slug]
├── components/         Header, Footer, ThemeToggle (React), FormattedDate
└── styles/global.css   Tailwind + dark mode + Shiki
```
