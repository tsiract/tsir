/**
 * Preloaded before every test file (`bunfig.toml`, `[test] preload`). It installs the network
 * block (TST-008), so a unit test that reaches a real host fails at the call site.
 */
import { installNetworkGuard } from '../framework/testing/src/network.ts';

installNetworkGuard();
