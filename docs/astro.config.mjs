import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "frogCP",
      description:
        "An open-source backend framework: typed entities, a REST API, a typed client, and row-level permissions compiled to SQL.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/frogcp/frogcp" },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [{ label: "Getting started", slug: "getting-started" }],
        },
        {
          label: "Guides",
          items: [{ label: "Writing a plugin", slug: "guides/plugins" }],
        },
      ],
    }),
  ],
});
