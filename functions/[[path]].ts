import type { ServerBuild } from '@remix-run/cloudflare';
import { createPagesFunctionHandler } from '@remix-run/cloudflare-pages';

export const onRequest: PagesFunction = async (context) => {
  const serverBuildPath = '../build/server';
  const serverBuild = (await import(serverBuildPath)) as unknown as ServerBuild;

  const handler = createPagesFunctionHandler({
    build: serverBuild,
  });

  return handler(context);
};
