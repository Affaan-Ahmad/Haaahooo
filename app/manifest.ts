import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Haaahooo",
    short_name: "Haaahooo",
    description: "Private messaging with friends.",
    start_url: "/",
    display: "standalone",
    background_color: "#07091f",
    theme_color: "#07091f",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
