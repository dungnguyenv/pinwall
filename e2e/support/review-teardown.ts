import { cleanUpReviewRun } from './review-setup.ts';

export default async function reviewTeardown(): Promise<void> {
  await cleanUpReviewRun();
}
