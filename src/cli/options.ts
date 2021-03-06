import { isHumanError } from '../server/errors';
import { Project } from '../server/project';

export interface IGlobalOptions {
  /**
   * Base directory of the interactive project.
   */
  project: Project;

  /**
   * Address of the Mixer API.
   */
  api: string;
}

export function printError(err: Error) {
  console.error(isHumanError(err) ? err.getHumanMessage() : err.message);
  process.exit(1);
}

export function failSpiner(spinner: { fail(message: string): void }) {
  return (err: Error): never => {
    if (isHumanError(err)) {
      spinner.fail(err.getHumanMessage());
      process.exit(1);
      throw new Error(''); // cannot be reached
    }

    spinner.fail(err.message);
    throw err;
  };
}
