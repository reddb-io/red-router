import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveDocHref } from "@/lib/docsLinkResolver";
import { getTranslations } from "next-intl/server";

// ── Page component ──────────────────────────────────────────────────────────

export default async function Page(props: { params: Promise<{ slug: string[] }> }) {
  const params = await props.params;
  const { source } = await import("../../../lib/source");
  const [{ DocsPage, DocsBody }, defaultMdxComponents] = await Promise.all([
    import("fumadocs-ui/layouts/docs/page"),
    import("fumadocs-ui/mdx"),
  ]);
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // English MDX rendered natively by Fumadocs with resolved links.
  const MDX = page.data.body;
  const docPath = page.file?.path || `${params.slug.join("/")}.md`;
  const DocsLink = (linkProps: React.ComponentProps<typeof defaultMdxComponents.a>) => {
    const resolved = linkProps.href ? resolveDocHref(linkProps.href, docPath) : linkProps.href;
    return <defaultMdxComponents.a {...linkProps} href={resolved} />;
  };

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, a: DocsLink }} />
      </DocsBody>
    </DocsPage>
  );
}

// ── Runtime metadata ───────────────────────────────────────────────────────

// Keep the docs route dynamic. Fumadocs' generated source includes build-only
// metadata that Next's Bun page-data workers cannot reliably traverse during
// generateStaticParams; rendering on request preserves the docs while keeping
// the production build Bun-compatible.
export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const { source } = await import("../../../lib/source");
  const page = source.getPage(params.slug);
  if (!page) return {};
  const t = await getTranslations("docs");

  return {
    title: t("pageMetadataTitle", { title: page.data.title }),
    description: page.data.description ?? t("pageMetadataDescription", { title: page.data.title }),
  };
}
