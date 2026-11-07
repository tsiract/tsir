// config/paths.ts — filesystem paths the console reads.
//
// `migrations` lives inside the app (not the repo root), so the admin owns its
// own schema history and `tsir migrate` from the app directory applies it.
export default {
  migrations: 'migrations',
};
