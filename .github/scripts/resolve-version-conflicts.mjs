// Resolves merge conflicts in the version files, then sets the fork version.
//
// Only manifest.json, package.json, versions.json and package-lock.json are
// touched. Each one is merged three ways: the base stage, the fork side and
// the upstream side. The fork side wins a real conflict, so fork-only fields
// (author, repository URLs) survive and upstream dependency bumps still land.
//
// Prints the resolved version on success.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const FILES = ["manifest.json", "package.json", "versions.json", "package-lock.json"];

const baseVersion = process.argv[2];

if (!baseVersion) {
	console.error("usage: resolve-version-conflicts.mjs <base-version>");
	process.exit(2);
}

const readStage = (stage, file) => {
	try {
		return JSON.parse(
			execFileSync("git", ["show", `:${stage}:${file}`], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
	} catch {
		return undefined;
	}
};

const isObject = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const mergeJson = (base, ours, theirs) => {
	if (same(ours, theirs)) return ours;
	if (same(base, theirs)) return ours;
	if (same(base, ours)) return theirs;
	if (isObject(base) && isObject(ours) && isObject(theirs)) {
		const merged = {};
		for (const key of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
			merged[key] = mergeJson(base[key], ours[key], theirs[key]);
		}
		return merged;
	}
	return ours;
};

const version = execFileSync("node", [".github/scripts/fork-release-version.mjs", baseVersion], {
	encoding: "utf8",
}).trim();

const mergedFiles = {};

for (const file of FILES) {
	const base = readStage(1, file);
	const ours = readStage(2, file);
	const theirs = readStage(3, file);

	if (base === undefined && ours === undefined && theirs === undefined) continue;

	mergedFiles[file] = mergeJson(base, ours ?? {}, theirs ?? {});
}

const minAppVersion = mergedFiles["manifest.json"]?.minAppVersion;

if (typeof minAppVersion !== "string") {
	console.error("The merged manifest.json has no minAppVersion.");
	process.exit(1);
}

for (const [file, merged] of Object.entries(mergedFiles)) {
	if (file === "manifest.json" || file === "package.json") {
		merged.version = version;
	}

	if (file === "versions.json") {
		merged[version] = minAppVersion;
	}

	if (file === "package-lock.json") {
		merged.version = version;
		if (isObject(merged.packages) && isObject(merged.packages[""])) {
			merged.packages[""].version = version;
		}
	}

	writeFileSync(file, JSON.stringify(merged, null, "\t"));
	console.log(`Resolved ${file}`);
}

console.log(version);
