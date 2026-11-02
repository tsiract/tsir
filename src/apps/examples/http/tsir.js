// tsir.js — project configuration, assembled from config/*.ts.
//
// Each file under config/ exports one section (app, cache, database, …);
// `configDir` merges them into the shape the console loader expects. This is
// the Laravel-style split: one file per concern, combined at load.
import { configDir } from '@tsir/config';

export default await configDir(`${import.meta.dir}/config`);
