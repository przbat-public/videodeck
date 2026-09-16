/** A promise that resolves after the given number of milliseconds */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
