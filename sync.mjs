import fs from "fs/promises";

const repoName = "auto-projects";
const projectsSchemaFile = "project-schema.json";

const GH_TOKEN = process.env.GH_PAT;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

if (!GH_TOKEN || !VERCEL_TOKEN) {
  console.error(
    "❌ Github Personal Access Token (GH_PAT) dan Vercel Token (VERCEL_TOKEN) tidak ada di Github Secrets!",
  );
  process.exit(1);
}

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const vercelHeaders = {
  Authorization: `Bearer ${VERCEL_TOKEN}`,
};

const GITHUB_API_BASE = "https://api.github.com";
const VERCEL_API_BASE = "https://api.vercel.com";
const VERCEL_PROJECTS_LIMIT = 100;

async function getVercelReadyProjects() {
  const res = await fetch(
    `${VERCEL_API_BASE}/v10/projects?limit=${VERCEL_PROJECTS_LIMIT}`,
    {
      headers: vercelHeaders,
    },
  );
  if (!res.ok) throw new Error(`Gagal membaca API Vercel: ${res.statusText}`);
  const data = await res.json();

  const vercelMap = new Map();
  for (const proj of data.projects || []) {
    const repoName = proj.link?.repo || proj.name;
    const prodTarget = proj.targets?.production;

    if (prodTarget && prodTarget.readyState === "READY") {
      const hasAlias =
        Array.isArray(prodTarget.alias) && prodTarget.alias.length > 0;
      const domain = hasAlias ? prodTarget.alias[0] : prodTarget.url;
      const prodUrl = `https://${domain}`;

      vercelMap.set(repoName.toLowerCase(), {
        vercelProjectId: proj.id,
        url: prodUrl,
        framework: proj.framework,
        updatedAt: new Date(prodTarget.createdAt).toISOString(),
      });
    }
  }
  return vercelMap;
}

async function getAllGithubRepos() {
  let page = 1;
  const repos = [];
  while (true) {
    const endpoint = `${GITHUB_API_BASE}/user/repos?per_page=100&page=${page}&affiliation=owner&sort=updated`;
    const res = await fetch(endpoint, { headers: ghHeaders });

    if (!res.ok) throw new Error(`Gagal membaca API GitHub: ${res.statusText}`);
    const pageRepos = await res.json();
    if (pageRepos.length === 0) break;
    repos.push(...pageRepos);
    page++;
  }
  return repos;
}

async function getProjectSchema(owner, repoName) {
  const endpoint = `${GITHUB_API_BASE}/repos/${owner}/${repoName}/contents/${projectsSchemaFile}`;
  const res = await fetch(endpoint, { headers: ghHeaders });

  if (res.status === 404) return null;
  if (!res.ok) return null;

  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  try {
    return JSON.parse(content);
  } catch {
    console.warn(`⚠️ Format JSON salah di ${repoName}/${projectsSchemaFile}`);
    return null;
  }
}

async function main() {
  console.log("Sedang mengambil data proyek dari Vercel...");
  const vercelMap = await getVercelReadyProjects();

  console.log("Memindahkan data proyek dari GitHub...");
  const repos = await getAllGithubRepos();

  const finalProjects = [];

  for (const repo of repos) {
    if (repo.name.toLowerCase() === repoName.toLowerCase()) continue;

    const vercelInfo = vercelMap.get(repo.name.toLowerCase());
    if (!vercelInfo) continue;

    const schema = await getProjectSchema(repo.owner.login, repo.name);
    if (!schema) continue;

    if (schema.listed === false) continue;

    console.log(`Berhasil memindahkan proyek: ${repo.name}`);

    finalProjects.push({
      id: repo.id,
      repoName: repo.name,
      title: schema.title || repo.name,
      description: schema.desk || schema.description || repo.description || "",
      stack: Array.isArray(schema.stack) ? schema.stack : [],
      icon: schema.icon || "",
      url: schema.url || vercelInfo.url || repo.homepage || "",
      githubUrl: repo.private ? null : repo.html_url,
      public: !repo.private,
      listed: schema.listed ?? true,
      stars: repo.stargazers_count,
      lastDeployedAt: vercelInfo.updatedAt,
    });
  }

  finalProjects.sort(
    (a, b) => new Date(b.lastDeployedAt) - new Date(a.lastDeployedAt),
  );

  await fs.writeFile("projects.json", JSON.stringify(finalProjects, null, 2));
  console.log(
    `Berhasil memindahkan ${finalProjects.length} proyek ke file projects.json`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
