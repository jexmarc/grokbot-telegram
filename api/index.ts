import { vercelFetch } from "../src/adapters/vercel/handler.js";

export default {
  async fetch(request: Request): Promise<Response> {
    return vercelFetch(request);
  },
};
