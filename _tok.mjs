import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const npmrc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8')
const match = /_authToken\s*=\s*(\S+)/.exec(npmrc)
if (!match) {
  console.log('no token in .npmrc')
  process.exit(0)
}
const token = match[1]

function request(url, method, body) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'npm-diag',
        accept: 'application/json',
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ code: res.statusCode, body: data }))
    })
    req.on('error', (e) => resolve({ code: 0, body: String(e.message) }))
    req.setTimeout(15000, () => { req.destroy(); resolve({ code: 0, body: 'timeout' }) })
    if (body) req.write(body)
    req.end()
  })
}

const res = await request('https://registry.npmjs.org/-/npm/v1/tokens', 'GET')
console.log('tokens endpoint:', res.code)
if (res.code === 200) {
  const doc = JSON.parse(res.body)
  const rows = doc.objects ?? doc
  for (const row of rows) {
    console.log(JSON.stringify({
      id: row.id,
      name: row.name,
      created: row.created,
      updated: row.updated,
      cidr: row.cidr,
      readonly: row.readonly,
      token: typeof row.token === 'string' ? `${row.token.slice(0, 4)}…` : row.token,
      keys: Object.keys(row),
    }))
  }
} else {
  console.log(res.body.slice(0, 400))
}
