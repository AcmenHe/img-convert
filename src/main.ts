import JSZip from "jszip";

import "./style.css";
import {
  MAX_OUTPUT_BYTES,
  encodeBmp32,
  estimateBmp32Size,
  fitDimensionsToMaxBytes,
} from "./bmp";

type JobStatus = "ready" | "converting" | "converted" | "error";

type FileJob = {
  id: string;
  file: File;
  originalWidth: number | null;
  originalHeight: number | null;
  previewUrl: string | null;
  bitmap: ImageBitmap | null;
  status: JobStatus;
  errorMessage: string | null;
  outputBlob: Blob | null;
  outputUrl: string | null;
  outputWidth: number | null;
  outputHeight: number | null;
  scaled: boolean;
};

function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Failed to bind UI element: ${selector}`);
  }
  return element;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(value: number): string {
  if (value === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** index;
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function createDownloadUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

function getBmpFileName(fileName: string): string {
  return fileName.replace(/\.png$/i, "") + ".bmp";
}

function getStatusLabel(job: FileJob): string {
  switch (job.status) {
    case "ready":
      return "待转换";
    case "converting":
      return "转换中";
    case "converted":
      return "已完成";
    case "error":
      return "失败";
    default:
      return "-";
  }
}

function extractPixelsWebGL(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): ImageData | null {
  try {
    const canvas = new OffscreenCanvas(width, height);
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) return null;

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(
      vs,
      "#version 300 es\n" +
        "in vec2 a_pos;\n" +
        "out vec2 v_uv;\n" +
        "void main(){v_uv=a_pos*0.5+0.5;gl_Position=vec4(a_pos,0,1);}",
    );
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(
      fs,
      "#version 300 es\n" +
        "precision highp float;\n" +
        "uniform sampler2D u_tex;\n" +
        "in vec2 v_uv;\n" +
        "out vec4 o_color;\n" +
        "void main(){o_color=texture(u_tex,v_uv);}",
    );
    gl.compileShader(fs);

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    gl.deleteTexture(tex);
    gl.deleteBuffer(buf);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return new ImageData(new Uint8ClampedArray(pixels.buffer), width, height);
  } catch {
    return null;
  }
}

function drawScaledBitmap(bitmap: ImageBitmap, width: number, height: number): ImageData {
  const webglResult = extractPixelsWebGL(bitmap, width, height);
  if (webglResult) return webglResult;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("浏览器不支持 2D Canvas。");
  }

  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);

  return context.getImageData(0, 0, width, height);
}

async function buildJob(file: File, id: string): Promise<FileJob> {
  const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
  if (!isPng) {
    return {
      id,
      file,
      originalWidth: null,
      originalHeight: null,
      previewUrl: null,
      bitmap: null,
      status: "error",
      errorMessage: "仅支持 PNG 文件",
      outputBlob: null,
      outputUrl: null,
      outputWidth: null,
      outputHeight: null,
      scaled: false,
    };
  }

  try {
    const bitmap = await createImageBitmap(file, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    return {
      id,
      file,
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
      previewUrl: createDownloadUrl(file),
      bitmap,
      status: "ready",
      errorMessage: null,
      outputBlob: null,
      outputUrl: null,
      outputWidth: null,
      outputHeight: null,
      scaled: false,
    };
  } catch (error) {
    return {
      id,
      file,
      originalWidth: null,
      originalHeight: null,
      previewUrl: null,
      bitmap: null,
      status: "error",
      errorMessage: error instanceof Error ? `解析失败：${error.message}` : "解析失败",
      outputBlob: null,
      outputUrl: null,
      outputWidth: null,
      outputHeight: null,
      scaled: false,
    };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root was not found.");
}

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Browser Only</p>
      <h1>PNG 批量转 BMP</h1>
      <p class="hero-copy">
        一次选中多张 PNG，本地完成转换并下载。每张图都按 32 位 BMP 导出，超过 10MB 会自动缩小尺寸，尽量保留颜色和透明度。
      </p>
    </section>

    <section class="panel">
      <label class="dropzone" id="dropzone" for="file-input">
        <input id="file-input" type="file" accept="image/png,.png" multiple hidden />
        <span class="dropzone-title">拖拽多张 PNG 到这里，或点击批量选择</span>
        <span class="dropzone-subtitle">支持多文件转换；全部操作都在浏览器内完成</span>
      </label>

      <div class="actions">
        <button id="convert-btn" class="button primary" type="button" disabled>转换全部</button>
        <button id="download-all-btn" class="button ghost" type="button" disabled>打包下载 ZIP</button>
      </div>

      <p id="status" class="status">等待选择 PNG 文件。</p>
      <p id="error" class="error" hidden></p>
    </section>

    <section class="summary-grid">
      <article class="card stat-card">
        <span class="stat-label">当前批次</span>
        <strong id="summary-total" class="stat-value">0</strong>
      </article>
      <article class="card stat-card">
        <span class="stat-label">已完成</span>
        <strong id="summary-success" class="stat-value">0</strong>
      </article>
      <article class="card stat-card">
        <span class="stat-label">失败</span>
        <strong id="summary-error" class="stat-value">0</strong>
      </article>
      <article class="card stat-card">
        <span class="stat-label">BMP 总大小</span>
        <strong id="summary-size" class="stat-value">0 B</strong>
      </article>
    </section>

    <section class="card jobs-card">
      <div class="card-head">
        <h2>转换列表</h2>
        <span id="jobs-tag" class="tag">空列表</span>
      </div>
      <div id="jobs-empty" class="placeholder jobs-empty">上传后会在这里显示每张图片的转换状态和下载入口</div>
      <div id="jobs-list" class="jobs-list" hidden></div>
    </section>
  </main>
`;

const fileInput = mustQuery<HTMLInputElement>("#file-input");
const dropzone = mustQuery<HTMLLabelElement>("#dropzone");
const convertButton = mustQuery<HTMLButtonElement>("#convert-btn");
const downloadAllButton = mustQuery<HTMLButtonElement>("#download-all-btn");
const status = mustQuery<HTMLParagraphElement>("#status");
const error = mustQuery<HTMLParagraphElement>("#error");
const summaryTotal = mustQuery<HTMLElement>("#summary-total");
const summarySuccess = mustQuery<HTMLElement>("#summary-success");
const summaryError = mustQuery<HTMLElement>("#summary-error");
const summarySize = mustQuery<HTMLElement>("#summary-size");
const jobsTag = mustQuery<HTMLElement>("#jobs-tag");
const jobsEmpty = mustQuery<HTMLElement>("#jobs-empty");
const jobsList = mustQuery<HTMLDivElement>("#jobs-list");

let jobs: FileJob[] = [];
let isConverting = false;
let isZipping = false;

function setStatus(message: string): void {
  status.textContent = message;
}

function setError(message: string | null): void {
  if (message) {
    error.hidden = false;
    error.textContent = message;
  } else {
    error.hidden = true;
    error.textContent = "";
  }
}

function revokeJobResources(job: FileJob): void {
  if (job.previewUrl) {
    URL.revokeObjectURL(job.previewUrl);
  }
  if (job.outputUrl) {
    URL.revokeObjectURL(job.outputUrl);
  }
  job.bitmap?.close();
}

function disposeJobs(): void {
  jobs.forEach(revokeJobResources);
  jobs = [];
}

function updateActionState(): void {
  const readyOrFailed = jobs.some((job) => job.status === "ready" || job.status === "error");
  const convertedCount = jobs.filter((job) => job.status === "converted" && job.outputBlob).length;

  convertButton.disabled = isConverting || jobs.length === 0 || !readyOrFailed;
  downloadAllButton.disabled = isConverting || isZipping || convertedCount === 0;
}

function renderJobs(): void {
  const successCount = jobs.filter((job) => job.status === "converted").length;
  const errorCount = jobs.filter((job) => job.status === "error").length;
  const totalOutputBytes = jobs.reduce((sum, job) => sum + (job.outputBlob?.size ?? 0), 0);

  summaryTotal.textContent = String(jobs.length);
  summarySuccess.textContent = String(successCount);
  summaryError.textContent = String(errorCount);
  summarySize.textContent = formatBytes(totalOutputBytes);
  jobsTag.textContent = jobs.length === 0 ? "空列表" : `${jobs.length} 个文件`;

  if (jobs.length === 0) {
    jobsEmpty.hidden = false;
    jobsList.hidden = true;
    jobsList.innerHTML = "";
    updateActionState();
    return;
  }

  jobsEmpty.hidden = true;
  jobsList.hidden = false;
  jobsList.innerHTML = jobs
    .map((job) => {
      const dimensionLabel =
        job.originalWidth && job.originalHeight
          ? `${job.originalWidth} × ${job.originalHeight}`
          : "-";
      const targetLabel =
        job.outputWidth && job.outputHeight ? `${job.outputWidth} × ${job.outputHeight}` : "-";
      const sizeLabel = job.outputBlob ? formatBytes(job.outputBlob.size) : "-";
      const estimatedLabel =
        job.outputWidth && job.outputHeight
          ? formatBytes(estimateBmp32Size(job.outputWidth, job.outputHeight))
          : "-";
      const scaleLabel = job.outputBlob ? (job.scaled ? "已缩小" : "原尺寸") : "-";
      const downloadMarkup =
        job.outputUrl && job.outputBlob
          ? `<a class="button ghost row-download" href="${job.outputUrl}" download="${escapeHtml(
              getBmpFileName(job.file.name),
            )}">下载 BMP</a>`
          : `<span class="button ghost disabled row-download" aria-disabled="true">下载 BMP</span>`;
      const previewMarkup = job.previewUrl
        ? `<img src="${job.previewUrl}" alt="${escapeHtml(job.file.name)} 预览图" />`
        : `<div class="thumb-placeholder">无预览</div>`;
      const messageMarkup = job.errorMessage
        ? `<p class="job-message error-inline">${escapeHtml(job.errorMessage)}</p>`
        : job.status === "converted"
          ? `<p class="job-message">转换完成，可单独下载或批量打包下载。</p>`
          : `<p class="job-message">等待转换。</p>`;

      return `
        <article class="job-row">
          <div class="job-thumb">${previewMarkup}</div>
          <div class="job-main">
            <div class="job-head">
              <h3>${escapeHtml(job.file.name)}</h3>
              <span class="tag">${getStatusLabel(job)}</span>
            </div>
            <div class="job-meta">
              <span>原图尺寸：${dimensionLabel}</span>
              <span>原图大小：${formatBytes(job.file.size)}</span>
              <span>目标尺寸：${targetLabel}</span>
              <span>预计大小：${estimatedLabel}</span>
              <span>实际大小：${sizeLabel}</span>
              <span>缩放状态：${scaleLabel}</span>
            </div>
            ${messageMarkup}
          </div>
          <div class="job-actions">${downloadMarkup}</div>
        </article>
      `;
    })
    .join("");

  updateActionState();
}

async function replaceJobs(files: File[]): Promise<void> {
  disposeJobs();
  renderJobs();
  setError(null);
  setStatus("正在载入图片...");

  const nextJobs: FileJob[] = [];
  for (const [index, file] of files.entries()) {
    nextJobs.push(await buildJob(file, `${Date.now()}-${index}`));
  }

  jobs = nextJobs;
  const invalidCount = jobs.filter((job) => job.status === "error" && !job.bitmap).length;

  renderJobs();
  if (jobs.length === 0) {
    setStatus("等待选择 PNG 文件。");
    return;
  }

  if (invalidCount > 0) {
    setError(`已忽略或标记 ${invalidCount} 个不可转换文件。`);
  }
  setStatus(`已载入 ${jobs.length} 个文件，可以开始批量转换。`);
}

async function convertJob(job: FileJob): Promise<void> {
  if (!job.bitmap || !job.originalWidth || !job.originalHeight) {
    throw new Error(job.errorMessage ?? "图片尚未成功载入");
  }

  const target = fitDimensionsToMaxBytes(job.originalWidth, job.originalHeight, MAX_OUTPUT_BYTES);
  const imageData = drawScaledBitmap(job.bitmap, target.width, target.height);
  const blob = encodeBmp32(imageData);

  if (blob.size > MAX_OUTPUT_BYTES) {
    throw new Error("结果仍超过 10MB，请换一张更小的 PNG");
  }

  if (job.outputUrl) {
    URL.revokeObjectURL(job.outputUrl);
  }

  job.outputBlob = blob;
  job.outputUrl = createDownloadUrl(blob);
  job.outputWidth = target.width;
  job.outputHeight = target.height;
  job.scaled = target.scaled;
  job.errorMessage = null;
  job.status = "converted";
}

async function convertAllJobs(): Promise<void> {
  if (jobs.length === 0 || isConverting) {
    return;
  }

  isConverting = true;
  setError(null);
  setStatus("正在批量转换 BMP...");
  updateActionState();

  for (const [index, job] of jobs.entries()) {
    if (job.status === "converted") {
      continue;
    }

    if (job.status === "error" && !job.bitmap) {
      continue;
    }

    job.status = "converting";
    renderJobs();

    try {
      await convertJob(job);
      setStatus(`已完成 ${index + 1} / ${jobs.length} 个文件。`);
    } catch (error) {
      job.status = "error";
      job.outputBlob = null;
      if (job.outputUrl) {
        URL.revokeObjectURL(job.outputUrl);
        job.outputUrl = null;
      }
      job.outputWidth = null;
      job.outputHeight = null;
      job.scaled = false;
      job.errorMessage = error instanceof Error ? error.message : "转换失败";
    }

    renderJobs();
  }

  isConverting = false;
  const convertedCount = jobs.filter((job) => job.status === "converted").length;
  setStatus(`批量转换完成，共生成 ${convertedCount} 个 BMP 文件。`);
  updateActionState();
}

async function downloadAllAsZip(): Promise<void> {
  const convertedJobs = jobs.filter((job) => job.status === "converted" && job.outputBlob);
  if (convertedJobs.length === 0 || isZipping) {
    return;
  }

  isZipping = true;
  updateActionState();
  setError(null);
  setStatus("正在打包 ZIP...");

  try {
    const zip = new JSZip();
    const nameMap = new Map<string, number>();

    for (const job of convertedJobs) {
      const baseName = getBmpFileName(job.file.name);
      const seenCount = nameMap.get(baseName) ?? 0;
      nameMap.set(baseName, seenCount + 1);

      const zipName =
        seenCount === 0
          ? baseName
          : `${baseName.replace(/\.bmp$/i, "")}-${seenCount + 1}.bmp`;

      zip.file(zipName, job.outputBlob as Blob);
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const zipUrl = createDownloadUrl(zipBlob);
    const anchor = document.createElement("a");
    anchor.href = zipUrl;
    anchor.download = "bmp-batch.zip";
    anchor.click();
    URL.revokeObjectURL(zipUrl);

    setStatus(`已打包 ${convertedJobs.length} 个 BMP 文件。`);
  } catch (error) {
    setError(error instanceof Error ? error.message : "ZIP 打包失败");
  } finally {
    isZipping = false;
    updateActionState();
  }
}

function handleFiles(fileList: FileList | null): void {
  const files = Array.from(fileList ?? []);
  if (files.length === 0) {
    return;
  }

  void replaceJobs(files);
}

fileInput.addEventListener("change", () => {
  handleFiles(fileInput.files);
});

convertButton.addEventListener("click", () => {
  void convertAllJobs();
});

downloadAllButton.addEventListener("click", () => {
  void downloadAllAsZip();
});

dropzone.addEventListener("dragenter", () => {
  dropzone.classList.add("dragging");
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});

dropzone.addEventListener("dragleave", (event) => {
  if (event.target === dropzone) {
    dropzone.classList.remove("dragging");
  }
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  handleFiles(event.dataTransfer?.files ?? null);
});

window.addEventListener("beforeunload", () => {
  disposeJobs();
});
