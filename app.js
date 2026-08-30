(function(){
  'use strict';

  /* ---------- DOM ---------- */
  const els = {
    tabs: document.getElementById('tabs'),
    phaseLabel: document.getElementById('phaseLabel'),
    ring: document.getElementById('ring'),
    ringWrap: document.getElementById('ringWrap'),
    stage: document.getElementById('stage'),
    hint: document.getElementById('hint'),
    clock: document.getElementById('clock'),
    roundLabel: document.getElementById('roundLabel'),
    config: document.getElementById('config'),
    controlsIdle: document.getElementById('controlsIdle'),
    controlsRun: document.getElementById('controlsRun'),
    btnStart: document.getElementById('btnStart'),
    btnPause: document.getElementById('btnPause'),
    btnReset: document.getElementById('btnReset'),
    cfgRounds: document.getElementById('cfgRounds'),
    cfgCountdown: document.getElementById('cfgCountdown'),
    cfgSprintTick: document.getElementById('cfgSprintTick'),
  };
  const player = document.getElementById('player');
  const durationInputs = {
    sprint: document.getElementById('cfgSprint'),
    walk:   document.getElementById('cfgWalk'),
    steps:  document.getElementById('cfgSteps'),
    rest:   document.getElementById('cfgRest'),
  };

  const RING_CIRC = 2 * Math.PI * 52;
  // 비프음 최고 배음이 4400Hz라 22050Hz면 충분하고, 블롭 크기가 절반으로 줄어든다.
  const SAMPLE_RATE = 22050;

  /* 구간 정의. 화면 색·이름과 전환음이 한곳에 모여 있어
     구간을 추가할 때 여기만 건드리면 된다. */
  const PHASES = {
    ready:  { text:'준비',        color:'#5B7A99' },
    sprint: { text:'전력질주',    color:'#FF5A36', beep:'sprint_start' },
    steps:  { text:'잔발 스텝',   color:'#A78BFA', beep:'steps_start'  },
    walk:   { text:'걷기 / 회복', color:'#33D6A6', beep:'rest_start'   },
    rest:   { text:'휴식',        color:'#33D6A6', beep:'rest_start'   },
    done:   { text:'완료',        color:'#FFD166', beep:'done'         },
  };

  const MODES = {
    two:   { phases:['sprint','walk'] },
    three: { phases:['sprint','steps','rest'] },
  };
  let mode = 'two';

  /* ---------- 상태 ----------
     화면 전환과 이벤트 처리는 전부 이 값 하나만 보고 결정한다.
     PREPARING 중에는 무음 프라이머가 재생되는데, 여기서 오는
     ended/pause 이벤트를 세션 종료로 오해하면 안 된다. */
  const IDLE='idle', PREPARING='preparing', RUNNING='running', PAUSED='paused', DONE='done';
  let state = IDLE;
  let plan = null;
  let rafId = 0;
  let trackUrl = null;
  let primerUrl = null;

  /* ---------- 설정 ---------- */
  function readConfig(){
    const int = (el, fallback, min) => {
      const v = parseInt(el.value, 10);
      return Math.max(min, isNaN(v) ? fallback : v);
    };
    const phases = MODES[mode].phases;
    const durations = {};
    phases.forEach(ph => { durations[ph] = int(durationInputs[ph], 20, 1); });
    return {
      phases,
      durations,
      rounds: int(els.cfgRounds, 8, 1),
      countdown: int(els.cfgCountdown, 5, 0),
      sprintTick: els.cfgSprintTick.checked,
    };
  }

  /* ---------- 세션 구성 ---------- */
  function buildPlan(cfg){
    const segments = [];
    let t = 0;
    segments.push({start:0, end:cfg.countdown, phase:'ready', round:0});
    t = cfg.countdown;
    for(let r=1; r<=cfg.rounds; r++){
      for(const ph of cfg.phases){
        segments.push({start:t, end:t+cfg.durations[ph], phase:ph, round:r});
        t += cfg.durations[ph];
      }
    }
    const total = t;
    segments.push({start:t, end:t+1.2, phase:'done', round:cfg.rounds});

    const beeps = [];
    // 카운트다운 전 구간에서 1초마다.
    for(let k=0; k<cfg.countdown; k++) beeps.push({t:k, type:'tick'});
    segments.forEach(seg=>{
      const meta = PHASES[seg.phase];
      if(meta.beep) beeps.push({t:seg.start, type:meta.beep});
      // 질주 중 1초 카운트음. 시작과 끝은 전환음이 이미 울리므로 사이 초에만.
      if(seg.phase==='sprint' && cfg.sprintTick){
        for(let k=1; k < seg.end-seg.start; k++) beeps.push({t:seg.start+k, type:'tick'});
      }
    });
    return {segments, beeps, total, rounds:cfg.rounds};
  }

  /* ---------- 오디오 생성 ---------- */
  async function renderTrack(p){
    const ctx = new OfflineAudioContext(1, Math.ceil((p.total+1.5)*SAMPLE_RATE), SAMPLE_RATE);
    // 홀수 배음(사각파에 가까운 음색)이 같은 피크에서 가장 크게 들리고
    // 바람·차 소리를 잘 뚫는다. 배음끼리 위상이 어긋나 합이 1.46이어도
    // 실제 피크는 0.95 근처라 클리핑되지 않는다.
    const PURE = [[1,1]];
    const RICH = [[1,0.5],[3,0.3],[5,0.2]];
    function beep(time, freq, dur, peak, partials){
      partials.forEach(([mult, rel])=>{
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        const g = ctx.createGain();
        const amp = peak * rel;
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(amp, time+0.005);
        g.gain.setValueAtTime(amp, time+dur*0.75);
        g.gain.linearRampToValueAtTime(0, time+dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(time);
        osc.stop(time+dur+0.02);
      });
    }
    // 화면을 안 봐도 구분되도록 음높이와 횟수를 함께 다르게 한다.
    // 질주 = 높게 2번, 잔발 = 중간 3번, 휴식 = 낮게 길게 1번.
    p.beeps.forEach(e=>{
      switch(e.type){
        case 'tick':
          beep(e.t, 660, 0.08, 0.45, PURE); break;
        case 'sprint_start':
          beep(e.t,      880, 0.14, 1.42, RICH);
          beep(e.t+0.18, 880, 0.14, 1.42, RICH); break;
        case 'steps_start':
          beep(e.t,      587, 0.11, 1.42, RICH);
          beep(e.t+0.15, 587, 0.11, 1.42, RICH);
          beep(e.t+0.30, 587, 0.11, 1.42, RICH); break;
        case 'rest_start':
          beep(e.t,      440, 0.26, 1.42, RICH); break;
        case 'done':
          beep(e.t,      523, 0.15, 1.30, RICH);
          beep(e.t+0.18, 659, 0.15, 1.30, RICH);
          beep(e.t+0.36, 784, 0.22, 1.30, RICH); break;
      }
    });
    return ctx.startRendering();
  }

  // iOS는 백그라운드에서 WebAudio를 정지시키므로 렌더링 결과를
  // <audio> 엘리먼트가 재생할 수 있는 16bit PCM WAV 파일로 바꾼다.
  function encodeWav(samples, sampleRate){
    const dataSize = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    let o = 0;
    const str = s => { for(let i=0;i<s.length;i++) view.setUint8(o++, s.charCodeAt(i)); };
    const u32 = v => { view.setUint32(o, v, true); o += 4; };
    const u16 = v => { view.setUint16(o, v, true); o += 2; };
    str('RIFF'); u32(36 + dataSize); str('WAVE');
    str('fmt '); u32(16); u16(1); u16(1);
    u32(sampleRate); u32(sampleRate*2); u16(2); u16(16);
    str('data'); u32(dataSize);
    for(let i=0;i<samples.length;i++){
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(o, s < 0 ? s*0x8000 : s*0x7FFF, true);
      o += 2;
    }
    return URL.createObjectURL(new Blob([buf], {type:'audio/wav'}));
  }

  /* ---------- 화면 ---------- */
  // 표시할 화면은 상태에서만 결정한다. 개별 핸들러가 각자 토글하지 않는다.
  function renderScreen(){
    const idleScreen = (state===IDLE || state===DONE);
    els.config.classList.toggle('hidden', !idleScreen);
    els.controlsIdle.classList.toggle('hidden', !idleScreen);
    els.controlsRun.classList.toggle('hidden', idleScreen);
    els.tabs.classList.toggle('locked', !idleScreen);
    // 설정 화면에서 링은 00:00만 띄우며 자리만 차지한다. 그 자리를 설정에 준다.
    // 구간 이름과 라운드 표시는 남겨 두어 완료 메시지는 계속 보인다.
    els.ringWrap.classList.toggle('hidden', idleScreen);
    els.hint.classList.toggle('hidden', !idleScreen);
    // stage는 flex:1이라 남는 세로 공간을 전부 차지한다. 링이 없는 설정
    // 화면에서 그대로 두면 텍스트 두 줄만 남기고 위아래로 큰 여백이 생긴다.
    els.stage.classList.toggle('compact', idleScreen);
    els.btnStart.disabled = (state===PREPARING);
    els.btnPause.textContent = (state===PAUSED) ? '이어서' : '일시정지';
  }

  // 모드에 없는 구간의 입력줄은 감춘다.
  function renderMode(){
    const phases = MODES[mode].phases;
    els.tabs.querySelectorAll('.tab').forEach(btn=>{
      btn.classList.toggle('is-active', btn.dataset.mode===mode);
    });
    document.querySelectorAll('[data-phase-field]').forEach(row=>{
      row.classList.toggle('hidden', !phases.includes(row.dataset.phaseField));
    });
  }

  function findSegment(elapsed){
    for(const s of plan.segments){ if(elapsed>=s.start && elapsed<s.end) return s; }
    return plan.segments[plan.segments.length-1];
  }

  function renderClock(elapsed){
    if(!plan) return;
    const seg = findSegment(elapsed);
    const meta = PHASES[seg.phase];
    const remain = Math.max(0, Math.ceil(seg.end - elapsed));
    els.clock.textContent =
      String(Math.floor(remain/60)).padStart(2,'0') + ':' + String(remain%60).padStart(2,'0');
    els.phaseLabel.textContent = meta.text;
    els.phaseLabel.style.color = meta.color;
    els.ring.style.stroke = meta.color;
    els.roundLabel.textContent =
      seg.phase==='ready' ? '곧 시작합니다' :
      seg.phase==='done'  ? '수고하셨습니다' :
      seg.round + ' / ' + plan.rounds;

    const segDur = Math.max(0.001, seg.end - seg.start);
    const progress = Math.min(1, Math.max(0, (elapsed - seg.start)/segDur));
    els.ring.setAttribute('stroke-dasharray', RING_CIRC);
    els.ring.setAttribute('stroke-dashoffset', RING_CIRC * (1-progress));
  }

  function clearClock(){
    els.phaseLabel.textContent = '설정';
    els.phaseLabel.style.color = '';
    els.roundLabel.textContent = ' ';
    els.clock.textContent = '00:00';
    els.ring.setAttribute('stroke-dashoffset', RING_CIRC);
  }

  /* ---------- 진행 표시 ----------
     화면은 오디오 자체의 재생 위치를 따라간다. 잠금 해제 후에도 소리와 어긋나지 않는다. */
  function elapsed(){ return player.currentTime; }

  function frame(){
    renderClock(elapsed());
    rafId = (state===RUNNING) ? requestAnimationFrame(frame) : 0;
  }
  function startTicking(){ cancelAnimationFrame(rafId); rafId = requestAnimationFrame(frame); }
  function stopTicking(){ cancelAnimationFrame(rafId); rafId = 0; }

  /* ---------- 리소스 ---------- */
  function revoke(url){ if(url) URL.revokeObjectURL(url); }

  function silentPrimerUrl(){
    return encodeWav(new Float32Array(Math.round(SAMPLE_RATE*0.25)), SAMPLE_RATE);
  }

  function setupMediaSession(){
    if(!('mediaSession' in navigator)) return;
    try{
      navigator.mediaSession.metadata = new MediaMetadata({
        title:'인터벌 타이머', artist: plan.rounds + ' 라운드',
      });
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('play', resume);
    }catch(e){/* 지원 안 하면 무시 */}
  }

  /* ---------- 전환 ---------- */
  async function start(){
    if(state!==IDLE && state!==DONE) return;
    plan = buildPlan(readConfig());
    state = PREPARING;
    renderScreen();
    els.phaseLabel.textContent = '준비 중...';

    // iOS는 탭 제스처 안에서 동기적으로 play()가 호출된 엘리먼트만 잠금 해제한다.
    // await 이전에 무음으로 먼저 해제해 둔다. loop을 켜야 프라이머가 끝나면서
    // ended를 쏘지 않는다.
    revoke(primerUrl);
    primerUrl = silentPrimerUrl();
    player.loop = true;
    player.src = primerUrl;
    player.play().catch(()=>{});

    let url;
    try{
      const buffer = await renderTrack(plan);
      url = encodeWav(buffer.getChannelData(0), buffer.sampleRate);
    }catch(e){
      return fail('오디오 생성 실패');
    }
    if(state!==PREPARING){ revoke(url); return; }  // 준비 중 종료를 눌렀다면 버린다

    revoke(trackUrl);
    trackUrl = url;
    player.loop = false;
    player.src = trackUrl;
    try{
      await player.play();
    }catch(e){
      return fail('재생을 시작할 수 없습니다');
    }
    if(state!==PREPARING){ return; }

    state = RUNNING;
    renderScreen();
    setupMediaSession();
    startTicking();
  }

  function fail(message){
    state = IDLE;
    stopTicking();
    renderScreen();
    els.phaseLabel.textContent = message;
  }

  function pause(){
    if(state!==RUNNING) return;
    state = PAUSED;
    player.pause();
    stopTicking();
    renderScreen();
  }

  function resume(){
    if(state!==PAUSED) return;
    state = RUNNING;
    player.play().catch(()=>{ pause(); });
    renderScreen();
    startTicking();
  }

  function finish(){
    state = DONE;
    stopTicking();
    renderClock(plan.total + 1);
    renderScreen();
  }

  function reset(){
    state = IDLE;
    stopTicking();
    player.pause();
    player.loop = false;
    player.removeAttribute('src');
    player.load();
    revoke(trackUrl); trackUrl = null;
    revoke(primerUrl); primerUrl = null;
    plan = null;
    clearClock();
    renderScreen();
  }

  /* ---------- 이벤트 ----------
     전부 상태로 가드한다. PREPARING 중 프라이머가 내는 이벤트는 무시된다. */
  els.btnStart.addEventListener('click', start);
  els.btnPause.addEventListener('click', ()=>{ state===PAUSED ? resume() : pause(); });
  els.btnReset.addEventListener('click', reset);

  els.tabs.addEventListener('click', e=>{
    const btn = e.target.closest('.tab');
    if(!btn || state!==IDLE && state!==DONE) return;
    mode = btn.dataset.mode;
    renderMode();
  });

  player.addEventListener('ended', ()=>{ if(state===RUNNING) finish(); });

  // 전화 수신 등으로 시스템이 멈춘 경우에도 화면을 맞춘다.
  player.addEventListener('pause', ()=>{
    if(state===RUNNING && !player.ended) pause();
  });

  // 잠금 해제 후 rAF는 멈춰 있으므로 화면을 즉시 재생 위치에 맞춘다.
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState!=='visible') return;
    if(state===RUNNING){ renderClock(elapsed()); startTicking(); }
  });

  renderMode();
  renderScreen();
})();
