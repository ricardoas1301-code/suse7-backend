#!/usr/bin/env node
/**
 * S1.HF.6.9A.13B — ignore build no projeto Vercel PROD para branches rc/*.
 * exit 0 = skip build; exit 1 = proceed.
 *
 * DEV project (suse7-backend-dev) always proceeds.
 */
const PROD_PROJECT_ID = "prj_82lxqfRgGm33UeWMWvrQt9qe5EwZ";
const ref = String(process.env.VERCEL_GIT_COMMIT_REF || "");
const projectId = String(process.env.VERCEL_PROJECT_ID || "");

const isProdProject = projectId === PROD_PROJECT_ID;
const isRcBranch = /^rc\//.test(ref);

if (isProdProject && isRcBranch) {
  console.log(`[vercel-ignore] skip Preview on PROD project for branch ${ref}`);
  process.exit(0);
}

process.exit(1);
