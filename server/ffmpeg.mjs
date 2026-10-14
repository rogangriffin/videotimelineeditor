import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

export const ffmpegPath = process.env.FRAMECUT_FFMPEG || ffmpegStatic
export const ffprobePath = process.env.FRAMECUT_FFPROBE || ffprobeStatic.path

// No shell: media paths and project names never become executable command text.
export function runProcess(command, args, { signal, timeout = 0, onOutput, maxOutput = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Export cancelled.'))
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = timeout ? setTimeout(() => { timedOut = true; child.kill() }, timeout) : undefined
    child.stdout.on('data', chunk => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-maxOutput)
      onOutput?.(text)
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000) })
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.on('error', error => { clean(); reject(new Error(`Cannot start ${command}: ${error.message}`)) })
    child.on('close', code => {
      clean()
      if (signal?.aborted) reject(new Error('Export cancelled.'))
      else if (timedOut) reject(new Error('Media inspection timed out.'))
      else if (code !== 0) reject(new Error(stderr.trim() || `Media process exited with code ${code}.`))
      else resolve(stdout)
    })
  })
}

export function encoderArgs(encoder, oddSize = false) {
  if (encoder === 'h264_qsv') return ['-c:v', encoder, '-preset', 'veryfast', '-global_quality', '22', '-look_ahead', '0', '-pix_fmt', 'nv12']
  if (encoder === 'h264_nvenc') return ['-c:v', encoder, '-preset', 'p2', '-rc', 'vbr', '-cq', '22', '-b:v', '0', '-pix_fmt', 'yuv420p']
  if (encoder === 'h264_amf') return ['-c:v', encoder, '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22', '-pix_fmt', 'yuv420p']
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', oddSize ? 'yuv444p' : 'yuv420p']
}

export async function detectEncoder(binary = ffmpegPath, preferred = process.env.FRAMECUT_ENCODER) {
  const candidates = preferred ? [preferred] : ['h264_qsv', 'h264_nvenc', 'h264_amf', 'libx264']
  if (candidates.some(e => !['h264_qsv', 'h264_nvenc', 'h264_amf', 'libx264'].includes(e))) throw new Error('Unsupported FRAMECUT_ENCODER setting.')
  for (const encoder of candidates) {
    try {
      // A listed encoder is not proof that its hardware and driver work.
      await runProcess(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=s=128x128:r=30', '-frames:v', '3', ...encoderArgs(encoder), '-f', 'null', '-'], { timeout: 15000 })
      return encoder
    } catch (error) { if (encoder === 'libx264' || preferred) throw error }
  }
  throw new Error('No working H.264 encoder was found.')
}

export async function probe(filename, { signal, binary = ffprobePath } = {}) {
  return JSON.parse(await runProcess(binary, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', filename], { signal, timeout: 30000 }))
}
