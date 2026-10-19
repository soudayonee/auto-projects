import fs from "fs/promises";
import path from "path";

const centralRepoName = "auto-projects";
const projectsSchemaFile = "project-schema.json";

const GH_TOKEN = process.env.GH_PAT;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

if (!GH_TOKEN || !VERCEL_TOKEN) {
  console.error(
    "Github Personal Access Token (GH_PAT) dan Vercel Token (VERCEL_TOKEN) tidak ada di Github Secrets!",
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
const ICONS_DIR = "icons";
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
    const targetRepoName = proj.link?.repo || proj.name;
    const prodTarget = proj.targets?.production;

    if (prodTarget && prodTarget.readyState === "READY") {
      const hasAlias =
        Array.isArray(prodTarget.alias) && prodTarget.alias.length > 0;
      const domain = hasAlias ? prodTarget.alias[0] : prodTarget.url;
      const prodUrl = `https://${domain}`;

      vercelMap.set(targetRepoName.toLowerCase(), {
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
    console.warn(`Format JSON salah di ${repoName}/${projectsSchemaFile}`);
    return null;
  }
}

async function copyProjectIcon(owner, repoName, repoId, iconPath) {
  if (!iconPath) return { localPath: null, rawUrl: "" };

  if (iconPath.startsWith("http://") || iconPath.startsWith("https://")) {
    return { localPath: null, rawUrl: iconPath };
  }

  const cleanPath = iconPath.replace(/^\/+/, "");
  const endpoint = `${GITHUB_API_BASE}/repos/${owner}/${repoName}/contents/${cleanPath}`;

  const res = await fetch(endpoint, {
    headers: { ...ghHeaders, Accept: "application/vnd.github.raw+json" },
  });

  if (!res.ok) {
    console.warn(
      `Gagal mengambil ikon proyek dari ${repoName}/${cleanPath}: ${res.statusText}`,
    );
    return { localPath: null, rawUrl: "" };
  }

  const ext = path.extname(cleanPath) || ".png";
  const filename = `${repoId}${ext}`;
  const filePath = `${ICONS_DIR}/${filename}`;

  const arrayBuffer = await res.arrayBuffer();
  await fs.mkdir(ICONS_DIR, { recursive: true });
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${centralRepoName}/main/${ICONS_DIR}/${filename}`;
  return { localPath: filename, rawUrl };
}

async function cleanupOrphanedIcons(activeIconFiles) {
  try {
    const files = await fs.readdir(ICONS_DIR);
    for (const file of files) {
      if (!activeIconFiles.has(file)) {
        await fs.unlink(path.join(ICONS_DIR, file));
        console.log(
          `Berhasil menghapus ikon lama: ${file} dari folder ${ICONS_DIR}`,
        );
      }
    }
  } catch {
    console.warn(`Gagal untuk membersihkan ikon lama di folder ${ICONS_DIR}`);
  }
}

async function main() {
  console.log("Sedang mengambil data proyek dari Vercel...");
  const vercelMap = await getVercelReadyProjects();

  console.log("Memindahkan data proyek dari GitHub...");
  const repos = await getAllGithubRepos();

  const finalProjects = [];
  const activeIconFiles = new Set();

  for (const repo of repos) {
    if (repo.name.toLowerCase() === centralRepoName.toLowerCase()) continue;

    const vercelInfo = vercelMap.get(repo.name.toLowerCase());
    if (!vercelInfo) continue;

    const schema = await getProjectSchema(repo.owner.login, repo.name);
    if (!schema || schema.listed === false) continue;

    const { localPath, rawUrl } = await copyProjectIcon(
      repo.owner.login,
      repo.name,
      repo.id,
      schema.icon,
    );

    if (localPath) activeIconFiles.add(localPath);

    finalProjects.push({
      id: repo.id,
      repoName: repo.name,
      title: schema.title || repo.name,
      description: schema.desk || schema.description || repo.description || "",
      stack: Array.isArray(schema.stack) ? schema.stack : [],
      icon: rawUrl || "",
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
    `Berhasil mencatat ${finalProjects.length} proyek ke projects.json dan menyalin ikon proyek ke folder ${ICONS_DIR}`,
  );

  await cleanupOrphanedIcons(activeIconFiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
