/**
 * Preloaded into every test process (`node --import <this> --test`, see
 * run.ts): the module hooks have to be in place before a test file's own
 * imports of the port are resolved, and the engine's globals before the
 * port's modules run.
 */
import { installEngineGlobals } from "./engine.ts";
import "./hooks.ts";

installEngineGlobals();
