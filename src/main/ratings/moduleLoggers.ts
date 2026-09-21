import { getComponentLogger } from './logger';

// ──────────────────────────────────────────────────────────────────────────
// Module loggers — one per module, pre-configured with the component name.
// All log output goes through the centralized logger which dispatches to
// console, memory buffer (for LogViewer), and file.
// ──────────────────────────────────────────────────────────────────────────

export const log = {
  enricher: getComponentLogger('ratings'),
  idResolver: getComponentLogger('id-resolver'),
  ratingsFetcher: getComponentLogger('ratings-fetcher'),
  browserFetch: getComponentLogger('browserFetch'),
  browserGraphqlFetch: getComponentLogger('browserGraphqlFetch'),
  allocine: getComponentLogger('allocine'),
  imdbDataset: getComponentLogger('imdb-dataset'),
  imdbScraper: getComponentLogger('imdb-scraper'),
  imdbGraphql: getComponentLogger('imdb-graphql'),
  wikidata: getComponentLogger('wikidata'),
  cacheDb: getComponentLogger('cache-db'),
  connectionPool: getComponentLogger('fetch'),
  schedule: getComponentLogger('schedule'),
  cinemas: getComponentLogger('cinemas'),
  cineChateau: getComponentLogger('cine-chateau'),
  networkActivity: getComponentLogger('network'),
  shutdown: getComponentLogger('shutdown'),
};
