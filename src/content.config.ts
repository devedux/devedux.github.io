import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Colección "blog": lee todos los .md/.mdx de src/content/blog.
// El schema valida el frontmatter de cada post (falla el build si algo no cuadra).
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
