// www redirect Worker: every request to the www host gets a 301 to the same path and query on the bare domain.
// The target host is built once from the brand module and is never taken from the request, so no input can turn this into an open redirect.
import { ARCADE_NAME } from '../../arcade/brand.js';

const TARGET = 'https://' + ARCADE_NAME.toLowerCase() + '.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    return new Response(null, {
      status: 301,
      headers: {
        Location: TARGET + url.pathname + url.search,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  },
};
