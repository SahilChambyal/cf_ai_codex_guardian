export const isWorkflowFile = (p: string) =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) ||
  /(^|\/)action\.ya?ml$/.test(p);

export const isDockerfile = (p: string) =>
  /(^|\/)(Dockerfile|Containerfile)(\.[\w.-]+)?$/.test(p) ||
  /\.dockerfile$/i.test(p);

export const isCodeFile = (p: string) =>
  /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rb|java|kt|rs|php|cs|swift|scala)$/.test(p) &&
  !p.endsWith(".d.ts");

export const isTestFile = (p: string) =>
  // Eval datasets and fixtures deliberately contain violations.
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|evals?|fixtures?|testdata)\//.test(
    p
  ) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /_test\.go$/.test(p) ||
  /(^|\/)test_[^/]+\.py$/.test(p) ||
  /_test\.py$/.test(p);

export const isDocFile = (p: string) =>
  /\.(md|mdx|rst|txt|adoc)$/i.test(p) || /(^|\/)docs?\//.test(p);

export const isWranglerConfig = (p: string) =>
  /(^|\/)wrangler\.(toml|json|jsonc)$/.test(p);

export const isGeneratedOrVendored = (p: string) =>
  /(^|\/)(node_modules|vendor|dist|build|\.next|generated)\//.test(p) ||
  /\.(min\.js|lock|snap)$/.test(p) ||
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock)$/.test(
    p
  );

export const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};
