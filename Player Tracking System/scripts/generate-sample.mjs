/*
 * Generates data/sample-session.json — a self-contained recorded session
 * in the exact format the web UI loads and the real UWB pipeline will emit.
 * Run: node scripts/generate-sample.mjs [seconds]
 *
 * Standalone (no browser globals) on purpose, so it documents the format
 * without depending on the front-end modules.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const COURT = { length: 40, width: 20, goalLineInset: 3.5 };
const HZ = 20, STEP = 1 / HZ;
const seconds = parseInt(process.argv[2] || '90', 10);

const TEAM_COLORS = { A: '#3b82f6', B: '#f97316' };
const NAMES = ['Lind','Berg','Holm','Sand','Kallio','Niemi','Virtanen','Korhonen',
  'Eriksson','Karlsson','Nyman','Aalto'];
const LAYOUT = [
  { role:'GK',  x:4,  y:10, bias:0.05, max:3.5 },
  { role:'DEF', x:12, y:6,  bias:0.45, max:6.0 },
  { role:'DEF', x:12, y:14, bias:0.45, max:6.0 },
  { role:'CEN', x:20, y:10, bias:0.78, max:6.6 },
  { role:'FWD', x:28, y:6,  bias:0.85, max:6.9 },
  { role:'FWD', x:28, y:14, bias:0.85, max:6.9 },
];
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const serial = i => 'RV-' + (((0xA1B2 + i*2654435761)>>>0).toString(16).toUpperCase().slice(0,6).padStart(6,'0'));

let ni = 0, idx = 0;
const players = [];
for (const [team, attackRight] of [['A',true],['B',false]]) {
  LAYOUT.forEach((s,i) => {
    const homeX = attackRight ? s.x : COURT.length - s.x;
    players.push({
      id:`${team}${i+1}`, team, teamName: team==='A'?'Falcons':'Rovers',
      number: i===0?1:i+4, name: NAMES[ni++%NAMES.length], role:s.role,
      serial: serial(idx++), color: TEAM_COLORS[team],
      _x:homeX, _y:s.y, _vx:0, _vy:0, _hx:homeX, _hy:s.y, _bias:s.bias, _max:s.max,
      _ph: Math.random()*6.28, _fr: 0.3+Math.random()*0.5,
    });
  });
}

const ball = { x:20, y:10, tx:20, ty:10, repick:0 };
function stepBall(dt){
  ball.repick -= dt;
  if (ball.repick<=0){
    if (Math.random()<0.18){ ball.tx = Math.random()<0.5?3.5:36.5; ball.ty = 10+(Math.random()-0.5)*4; ball.repick=0.6+Math.random()*0.6; }
    else { ball.tx=4+Math.random()*32; ball.ty=2+Math.random()*16; ball.repick=0.8+Math.random()*1.6; }
  }
  const dx=ball.tx-ball.x, dy=ball.ty-ball.y, d=Math.hypot(dx,dy)||1, st=Math.min(d,9*dt);
  ball.x=clamp(ball.x+dx/d*st,0.3,39.7); ball.y=clamp(ball.y+dy/d*st,0.3,19.7);
}
function accel(p,tx,ty,dt){
  const dx=tx-p._x, dy=ty-p._y, dist=Math.hypot(dx,dy)||1e-6;
  const desired=p._max*clamp(dist/3,0,1);
  const dvx=dx/dist*desired-p._vx, dvy=dy/dist*desired-p._vy, dvm=Math.hypot(dvx,dvy)||1e-6;
  const a=Math.min(dvm,9*dt);
  p._vx+=dvx/dvm*a; p._vy+=dvy/dvm*a;
  const sp=Math.hypot(p._vx,p._vy);
  if (sp>p._max){ p._vx=p._vx/sp*p._max; p._vy=p._vy/sp*p._max; }
  p._x=clamp(p._x+p._vx*dt,0.3,39.7); p._y=clamp(p._y+p._vy*dt,0.3,19.7);
}

const frames = [];
let t = 0;
for (let i=0;i<seconds*HZ;i++){
  t += STEP;
  stepBall(STEP);
  for (const p of players){
    if (p.role==='GK'){ accel(p, p._hx+(ball.x-p._hx)*0.02, clamp(10+(ball.y-10)*0.6,8,12), STEP); }
    else {
      const wx=Math.sin(t*p._fr+p._ph)*3, wy=Math.cos(t*p._fr*0.7+p._ph*1.3)*3;
      accel(p, p._hx*(1-p._bias)+ball.x*p._bias+wx, p._hy*(1-p._bias)+ball.y*p._bias+wy, STEP);
    }
  }
  frames.push({ t:+t.toFixed(2), ball:{x:+ball.x.toFixed(3),y:+ball.y.toFixed(3)},
    players: players.map(p=>({id:p.id,x:+p._x.toFixed(3),y:+p._y.toFixed(3)})) });
}

const out = {
  meta: { venue:'Stirling Sports Hall (demo)', teamA:'Falcons', teamB:'Rovers',
    recordedAt: new Date().toISOString(), hz: HZ, note:'Synthetic sample for the prototype.' },
  court: { length: COURT.length, width: COURT.width },
  roster: players.map(p=>({id:p.id,team:p.team,teamName:p.teamName,number:p.number,
    name:p.name,role:p.role,serial:p.serial,color:p.color})),
  frames,
};

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'sample-session.json');
writeFileSync(file, JSON.stringify(out));
console.log(`Wrote ${file}: ${frames.length} frames, ${players.length} players, ${seconds}s.`);
