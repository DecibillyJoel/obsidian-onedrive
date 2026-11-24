// Computes the fork release version for a base version: <base>-fork.<N>.
// N is one more than the highest N already used for that base, so repeated
// builds of one upstream release stay ordered for BRAT.

import { execFileSync } from "node:child_process";

const base = process.argv[2];

if (!base) {
	console.error("usage: fork-release-version.mjs <base-version>");
	process.exit(2);
}

if (!/^\d+\.\d+\.\d+$/.test(base)) {
	console.error(`Base version is not major.minor.patch: ${base}`);
	process.exit(2);
}

const tags = execFileSync("git", ["tag", "-l", `${base}-fork.*`], { encoding: "utf8" })
	.split("\n")
	.map((tag) => tag.trim())
	.filter(Boolean);

let highest = 0;

for (const tag of tags) {
	const match = tag.match(/-fork\.(\d+)$/);
	if (match) highest = Math.max(highest, Number(match[1]));
}

console.log(`${base}-fork.${highest + 1}`);
