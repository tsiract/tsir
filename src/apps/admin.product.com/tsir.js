// tsir.js — project configuration for the Tsir admin application.
//
// Split into `config/*.ts` sections and merged by `configDir`. The database,
// mail, and session blocks are declared here so the console commands
// (`migrate`, `mail:preview`, `doctor`) can read them without booting the app.
import { configDir } from '@tsir/config';

export default await configDir(`${import.meta.dir}/config`);
