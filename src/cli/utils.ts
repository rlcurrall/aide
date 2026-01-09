import type { CommandModule } from 'yargs';

/**
 * A utility function to create a command module for yargs.
 * This function simply returns the provided module, and is simply
 * a helper for better type inference in TypeScript.
 *
 * @param module - The command module to be created.
 * @returns The same command module.
 */
export const createCommandModule = (module: CommandModule) => module;
