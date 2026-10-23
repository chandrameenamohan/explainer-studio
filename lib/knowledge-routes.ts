import type { StudioServer } from '../server.ts';
import type { StudioConfig } from './config.ts';
import { KnowledgeStore } from './knowledge-index.ts';
import type { JobRunner } from './jobs.ts';
import { installConceptRoutes } from './knowledge-api.ts';
import { installDraftRoutes } from './draft.ts';
import { installSeedRoutes } from './seed.ts';

// Creates the store and registers the concept, draft and seed routes.
export function installKnowledgeRoutes(app: StudioServer, config: StudioConfig, runner: JobRunner): { store: KnowledgeStore } {
  const store = new KnowledgeStore(config, app.catalog);
  store.summaryForVideo = store.summaryForVideo.bind(store); // safe to pass as a bare callback
  installConceptRoutes(app, config, store);
  installDraftRoutes(app, config, store);
  installSeedRoutes(app, config, store, runner);
  return { store };
}
