(function () {
  'use strict';

  var slideTrack = document.getElementById('slideTrack');
  var slides = document.querySelectorAll('.slide');
  var navLinks = document.querySelectorAll('.chapter-nav a');
  var progressBar = document.getElementById('progressBar');
  var currentChapter = 0;
  var totalChapters = slides.length;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isAnimating = false;

  // ── Horizontal navigation ──────────────────────────
  function navigateTo(idx) {
    if (idx < 0) idx = 0;
    if (idx >= totalChapters) idx = totalChapters - 1;
    if (idx === currentChapter && isAnimating) return;

    currentChapter = idx;
    isAnimating = true;
    slideTrack.style.transform = 'translateX(' + (-idx * 100) + 'vw)';
    updateNav(idx);
    updateProgress();
    triggerReveals(idx);

    setTimeout(function() { isAnimating = false; }, 1100);
  }

  function updateNav(idx) {
    navLinks.forEach(function (link, i) {
      link.classList.remove('active');
      link.removeAttribute('aria-current');
      // Fill progress rings for visited slides
      var circle = link.querySelector('.dot svg circle.progress');
      if (circle) {
        circle.style.strokeDashoffset = i <= idx ? '0' : '44';
      }
    });
    if (navLinks[idx]) {
      navLinks[idx].classList.add('active');
      navLinks[idx].setAttribute('aria-current', 'page');
    }
  }

  function updateProgress() {
    var progress = totalChapters > 1 ? (currentChapter / (totalChapters - 1)) * 100 : 0;
    progressBar.style.width = progress + '%';
  }

  // ── Trigger reveals when navigating to a slide ─────
  function triggerReveals(idx) {
    var slide = slides[idx];
    if (!slide) return;
    // Small delay for the transition to start
    setTimeout(function() {
      slide.querySelectorAll('.reveal').forEach(function(el) {
        el.classList.add('visible');
      });
      // Shield layers for chapter 6
      slide.querySelectorAll('.shield-layer').forEach(function(el) {
        el.classList.add('visible');
      });
      // Journey steps for chapter 9
      slide.querySelectorAll('.journey-step').forEach(function(el) {
        el.classList.add('visible');
      });
      // Engine cards
      slide.querySelectorAll('.engine-card').forEach(function(el) {
        el.classList.add('visible');
      });
      // Bridge connector
      slide.querySelectorAll('.bridge-connector').forEach(function(el) {
        el.classList.add('visible');
      });
      // Counters
      slide.querySelectorAll('.counter-value').forEach(function(el) {
        if (!el.dataset.counted) {
          el.dataset.counted = 'true';
          animateCounter(el);
        }
      });
    }, 200);
  }

  // ── Hero Signature Load Sequence (choreographed) ──
  function revealHeroSequence() {
    var logos = document.querySelector('.hero-logos');
    var words = document.querySelectorAll('.hero-word');
    var subtitle = document.querySelector('.hero-subtitle');
    var scrollHint = document.querySelector('.scroll-hint');

    setTimeout(function () {
      if (logos) logos.classList.add('show');
    }, 100);

    words.forEach(function (word, i) {
      setTimeout(function () {
        word.classList.add('show');
      }, 600 + i * 180);
    });

    var subtitleDelay = 600 + words.length * 180 + 100;
    setTimeout(function () {
      if (subtitle) subtitle.classList.add('hero-sub-show');
    }, subtitleDelay);

    setTimeout(function () {
      if (scrollHint) scrollHint.classList.add('hero-hint-show');
    }, subtitleDelay + 400);
  }

  if (reducedMotion) {
    document.querySelectorAll('.hero-word').forEach(function (w) { w.classList.add('show'); });
    var logos = document.querySelector('.hero-logos');
    if (logos) logos.classList.add('show');
    var sub = document.querySelector('.hero-subtitle');
    if (sub) sub.classList.add('hero-sub-show');
    var hint = document.querySelector('.scroll-hint');
    if (hint) hint.classList.add('hero-hint-show');
  } else {
    revealHeroSequence();
  }

  // ── Keyboard navigation ────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    var forward = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ';
    var backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';

    if (forward || backward) {
      e.preventDefault();

      // On architecture chapter, cycle through phases before advancing
      if (currentChapter === ARCH_CHAPTER) {
        if (forward) {
          if (archIdx < 1) {
            setArchPhase(archIdx + 1);
            return;
          }
          navigateTo(currentChapter + 1);
        } else {
          if (archIdx > 0) {
            setArchPhase(archIdx - 1);
            return;
          }
          navigateTo(currentChapter - 1);
        }
        return;
      }

      // On benefits chapter, cycle through panels before advancing
      if (currentChapter === BENEFITS_CHAPTER) {
        if (forward) {
          if (benefitIdx < benefitPanels.length - 1) {
            expandBenefitPanel(benefitIdx + 1);
            return;
          }
          // Last panel — advance to next chapter
          navigateTo(currentChapter + 1);
        } else {
          if (benefitIdx > 0) {
            expandBenefitPanel(benefitIdx - 1);
            return;
          }
          // First panel — go back to previous chapter
          navigateTo(currentChapter - 1);
        }
        return;
      }

      // On Why chapter, step through reasons before advancing
      if (currentChapter === WHY_CHAPTER) {
        if (forward) {
          if (whyIdx < whyReasons.length) { setWhyStep(whyIdx + 1); return; }
          navigateTo(currentChapter + 1);
        } else {
          if (whyIdx > 1) { setWhyStep(whyIdx - 1); return; }
          navigateTo(currentChapter - 1);
        }
        return;
      }

      navigateTo(forward ? currentChapter + 1 : currentChapter - 1);
      return;
    }

    switch (e.key) {
      case 'Home':
        e.preventDefault();
        navigateTo(0);
        break;
      case 'End':
        e.preventDefault();
        navigateTo(totalChapters - 1);
        break;
    }
  });

  // ── Mouse wheel → horizontal navigation ────────────
  var wheelTimeout;
  document.addEventListener('wheel', function(e) {
    e.preventDefault();
    clearTimeout(wheelTimeout);
    wheelTimeout = setTimeout(function() {
      var forward = e.deltaY > 20 || e.deltaX > 20;
      var backward = e.deltaY < -20 || e.deltaX < -20;
      if (!forward && !backward) return;

      // On architecture chapter, cycle through phases
      if (currentChapter === ARCH_CHAPTER) {
        if (forward && archIdx < 1) { setArchPhase(archIdx + 1); return; }
        if (backward && archIdx > 0) { setArchPhase(archIdx - 1); return; }
      }

      // On benefits chapter, cycle through panels
      if (currentChapter === BENEFITS_CHAPTER) {
        if (forward && benefitIdx < benefitPanels.length - 1) {
          expandBenefitPanel(benefitIdx + 1);
          return;
        }
        if (backward && benefitIdx > 0) {
          expandBenefitPanel(benefitIdx - 1);
          return;
        }
      }

      // On Why chapter, step through reasons
      if (currentChapter === WHY_CHAPTER) {
        if (forward && whyIdx < whyReasons.length) { setWhyStep(whyIdx + 1); return; }
        if (backward && whyIdx > 1) { setWhyStep(whyIdx - 1); return; }
      }

      navigateTo(forward ? currentChapter + 1 : currentChapter - 1);
    }, 50);
  }, { passive: false });

  // ── Touch swipe support ────────────────────────────
  var touchStartX = 0;
  var touchStartY = 0;
  document.addEventListener('touchstart', function(e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      var forward = dx < 0;
      if (currentChapter === ARCH_CHAPTER) {
        if (forward && archIdx < 1) { setArchPhase(archIdx + 1); return; }
        if (!forward && archIdx > 0) { setArchPhase(archIdx - 1); return; }
      }
      if (currentChapter === BENEFITS_CHAPTER) {
        if (forward && benefitIdx < benefitPanels.length - 1) {
          expandBenefitPanel(benefitIdx + 1);
          return;
        }
        if (!forward && benefitIdx > 0) {
          expandBenefitPanel(benefitIdx - 1);
          return;
        }
      }
      if (currentChapter === WHY_CHAPTER) {
        if (forward && whyIdx < whyReasons.length) { setWhyStep(whyIdx + 1); return; }
        if (!forward && whyIdx > 1) { setWhyStep(whyIdx - 1); return; }
      }
      navigateTo(forward ? currentChapter + 1 : currentChapter - 1);
    }
  }, { passive: true });

  // ── Chapter nav click handling ─────────────────────
  navLinks.forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var idx = parseInt(this.getAttribute('data-chapter'), 10);
      navigateTo(idx);
    });
  });

  // ── Animated counters ──────────────────────────────
  function animateCounter(el) {
    var target = parseInt(el.getAttribute('data-target'), 10);
    var suffix = el.getAttribute('data-suffix') || '';
    var duration = 2800;
    var start = null;

    function step(timestamp) {
      if (!start) start = timestamp;
      var progress = Math.min((timestamp - start) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 2.5);
      var current = Math.round(eased * target);
      el.textContent = current.toLocaleString() + suffix;
      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  // ── Typed hostname effect ──────────────────────────
  // Hostname is injected into the HTML via Jinja (data-hostname attribute on
  // #typedHostname). Keeping it in the DOM means this file stays 100% static
  // so Ansible can deploy it via copy (not template).
  var typedEl = document.getElementById('typedHostname');
  var hostname = (typedEl && typedEl.dataset.hostname) || 'unknown-host';
  var charIndex = 0;
  var typedStarted = false;

  function typeHostname() {
    if (charIndex <= hostname.length) {
      typedEl.textContent = hostname.substring(0, charIndex);
      charIndex++;
      setTimeout(typeHostname, reducedMotion ? 0 : 60);
    }
  }

  // ── Staggered list item reveals ────────────────────
  function assignListItemDelays() {
    var selectors = ['.engine-card ul', '.lifecycle-detail-panel ul', '.spotlight-card ul'];
    selectors.forEach(function(sel) {
      document.querySelectorAll(sel).forEach(function(ul) {
        var items = ul.querySelectorAll('li');
        items.forEach(function(li, i) {
          li.style.setProperty('--li-i', i);
        });
      });
    });
  }
  assignListItemDelays();

  // ── Architecture diagram: phase progression ────────
  var ARCH_CHAPTER = 7;
  var archSvg = document.getElementById('archSvg');
  var archLabel = document.getElementById('archPhaseLabel');
  var archPhaseTyped = document.getElementById('archPhaseTyped');
  var archSubtitleTyped = document.getElementById('archSubtitleTyped');
  var archIdx = 0; // 0 = monitor, 1 = deploy
  var archPhaseNames = ['Step 1. Monitor & Check', 'Step 2. Issue, Deploy & Verify'];
  var archSubtitleText = 'Three platforms. One automated flow.';
  var archSubtitleTyped_started = false;
  var archPhaseTypeTimer = null;
  var archSubtitleTypeTimer = null;
  // Holds every pending timer scheduled by the Step 2 deploy sequence so we can
  // cancel them as a unit when the user changes phase or leaves the slide.
  var archStepTimers = [];
  function clearArchStepTimers() {
    archStepTimers.forEach(function(id) { clearTimeout(id); });
    archStepTimers = [];
    stopFlowBall();
  }

  function typePhaseName(text) {
    if (archPhaseTypeTimer) clearTimeout(archPhaseTypeTimer);
    if (!archPhaseTyped) return;
    // Hide subtitle caret so only one cursor blinks at a time
    if (archSubtitleTyped) archSubtitleTyped.classList.add('caret-off');
    archPhaseTyped.textContent = '';
    var i = 0;
    function step() {
      if (i <= text.length) {
        archPhaseTyped.textContent = text.substring(0, i);
        i++;
        archPhaseTypeTimer = setTimeout(step, 50);
      }
    }
    step();
  }

  function typeArchSubtitle() {
    if (archSubtitleTyped_started) return;
    archSubtitleTyped_started = true;
    if (archSubtitleTypeTimer) clearTimeout(archSubtitleTypeTimer);
    if (!archSubtitleTyped) return;
    archSubtitleTyped.textContent = '';
    var i = 0;
    function step() {
      if (i <= archSubtitleText.length) {
        archSubtitleTyped.textContent = archSubtitleText.substring(0, i);
        i++;
        archSubtitleTypeTimer = setTimeout(step, 40);
      }
    }
    step();
  }

  function setArchPhase(idx) {
    // Cancel any pending Step 2 timers + flow-ball rAF from a previous run.
    // Without this, flipping rapidly between phases (or between slides) leaves
    // orphaned timers that keep firing and mutating class state out of sync
    // with the current phase.
    clearArchStepTimers();

    archIdx = idx;
    if (!archSvg) return;
    archSvg.classList.remove('arch-highlight-monitor', 'arch-highlight-deploy');
    if (idx === 0) archSvg.classList.add('arch-highlight-monitor');
    else archSvg.classList.add('arch-highlight-deploy');
    if (archLabel) {
      archLabel.classList.add('visible');
      typePhaseName(archPhaseNames[idx]);
    }
    // Sequential highlight for deploy phase: one step at a time, then all on
    var deployLines = archSvg.querySelectorAll('.arch-deploy-line');
    if (idx === 1) {
      // Reset all
      deployLines.forEach(function(el) {
        el.classList.remove('arch-line-visible', 'arch-line-highlight', 'arch-line-all-on');
      });

      // Helper: get all elements for a given step number
      function getStep(n) {
        return archSvg.querySelectorAll('.arch-deploy-line[data-step="' + n + '"]');
      }

      var numSteps = 4;

      // Show all as dimmed first
      archStepTimers.push(setTimeout(function() {
        deployLines.forEach(function(el) { el.classList.add('arch-line-visible'); });
      }, 200));

      // Highlight one step at a time with flow ball.
      // Pace reference: lifecycle-wheel particle flow (slow, deliberate). Scaling all
      // timings by ~2x vs the original tempo so the ball traversal reads as readable
      // rather than urgent. If you want to tune, change ballDuration and pulseMs — the
      // stepOffsets and cleanup timeout are derived from them.
      var ballDuration = 2000; // ms for ball to traverse a path
      var pulseMs = 700;       // ms to linger/pulse at PKI — matches the CSS ballPulse 0.7s animation
      // Step starts (seconds). Step 1's full chain = ballDuration + pulseMs + ballDuration
      // = 4.7s at these values. Subsequent steps are offset so each ball trip finishes
      // before the next begins (steps 2→3, 3→4 gap = 2.4s = ballDuration + 0.4s margin).
      var stepOffsets = [0, 2.0, 6.8, 9.2, 11.6];
      for (var s = 1; s <= numSteps; s++) {
        (function(step) {
          archStepTimers.push(setTimeout(function() {
            // Remove highlight from all
            deployLines.forEach(function(el) { el.classList.remove('arch-line-highlight'); });
            // Highlight this step (both box and line)
            getStep(step).forEach(function(el) { el.classList.add('arch-line-highlight'); });
            // Animate flow ball along the path
            var color = flowColors[step] || '#0F62FE';
            if (step === 1) {
              // Step 1: ball goes LEFT to PKI, pulses (cert generated!), then RIGHT to Web Servers
              animateFlowBall('archPathLeft', color, ballDuration, function() {
                // Pulse at PKI — "Vault generates the certificate"
                if (flowBall) {
                  flowBall.classList.add('pulsing');
                  archStepTimers.push(setTimeout(function() {
                    flowBall.classList.remove('pulsing');
                    animateFlowBall('archPathR1', color, ballDuration, null);
                  }, pulseMs));
                }
              });
            } else {
              animateFlowBall('archPathR' + step, color, ballDuration, null);
            }
          }, stepOffsets[step] * 1000));
        })(s);
      }

      // After all steps, light everything up.
      // 14s = last step start (11.6s) + ball trip (2s) + 0.4s settling buffer.
      archStepTimers.push(setTimeout(function() {
        stopFlowBall();
        deployLines.forEach(function(el) {
          el.classList.remove('arch-line-highlight');
          el.classList.add('arch-line-all-on');
        });
      }, 14000));
    } else {
      deployLines.forEach(function(el) {
        el.classList.remove('arch-line-visible', 'arch-line-highlight', 'arch-line-all-on');
      });
    }
  }

  // ── Architecture: flow ball animation along paths ──
  var flowBall = document.getElementById('archFlowBall');
  var flowBallAnim = null;
  var flowColors = { 1: '#0F62FE', 2: '#198038', 3: '#B28600', 4: '#009D9A' };

  function animateFlowBall(pathId, color, duration, onDone) {
    var path = document.getElementById(pathId);
    if (!path || !flowBall) { if (onDone) onDone(); return; }
    var len = path.getTotalLength();
    flowBall.setAttribute('fill', color);
    flowBall.style.setProperty('--ball-color', color);
    flowBall.classList.add('flowing');
    var startTime = null;
    function tick(ts) {
      if (!startTime) startTime = ts;
      var t = Math.min((ts - startTime) / duration, 1);
      // Ease out cubic
      var eased = 1 - Math.pow(1 - t, 3);
      var pt = path.getPointAtLength(eased * len);
      flowBall.setAttribute('cx', pt.x);
      flowBall.setAttribute('cy', pt.y);
      if (t < 1) {
        flowBallAnim = requestAnimationFrame(tick);
      } else {
        flowBall.classList.remove('flowing');
        if (onDone) onDone();
      }
    }
    if (flowBallAnim) cancelAnimationFrame(flowBallAnim);
    flowBallAnim = requestAnimationFrame(tick);
  }

  function stopFlowBall() {
    if (flowBallAnim) cancelAnimationFrame(flowBallAnim);
    if (flowBall) flowBall.classList.remove('flowing');
  }

  // ── Benefit panels: arrow-key progression ──────────
  var benefitPanels = document.querySelectorAll('.benefit-panel');
  var benefitIdx = 0; // which panel is expanded (0-2)
  var BENEFITS_CHAPTER = 6;

  function expandBenefitPanel(idx) {
    if (idx < 0) idx = 0;
    if (idx >= benefitPanels.length) idx = benefitPanels.length - 1;
    benefitIdx = idx;
    benefitPanels.forEach(function(p) { p.classList.remove('expanded'); });
    benefitPanels[idx].classList.add('expanded');
  }

  // ── Initialize ─────────────────────────────────────
  updateNav(0);
  updateProgress();
  triggerReveals(0);

  // ── Why slide: manual step-through of reasons ─────
  // Presenter-controlled: arrival fades 4 cards in as dim and spotlights reason 1.
  // Each forward input (arrow/wheel/swipe) moves the spotlight to the next reason;
  // previously-discussed cards keep a "visited" treatment. Past the last reason,
  // the chapter advances. Backward input retreats through reasons, then out of
  // the chapter at reason 1.
  var WHY_CHAPTER = 3;
  var whyReasons = document.querySelectorAll('.why-reason');
  var whyEnterTimers = [];
  var whyIdx = 0; // 0 = not entered, 1..N = currently spotlit reason

  function clearWhyEnterTimers() {
    whyEnterTimers.forEach(function(t) { clearTimeout(t); });
    whyEnterTimers = [];
  }

  function setWhyStep(idx) {
    clearWhyEnterTimers(); // manual advance overrides any in-flight stagger
    if (idx < 1) idx = 1;
    if (idx > whyReasons.length) idx = whyReasons.length;
    whyIdx = idx;
    whyReasons.forEach(function(el, i) {
      el.classList.remove('reason-spotlight', 'reason-all-on', 'reason-dim');
      if (i + 1 < idx) el.classList.add('reason-all-on');      // already discussed
      else if (i + 1 === idx) el.classList.add('reason-spotlight'); // current
      else el.classList.add('reason-dim');                     // not yet discussed
    });
  }

  function enterWhy() {
    // Stagger-fade cards in as dim, then spotlight reason 1 and wait for the
    // presenter's first advance input.
    clearWhyEnterTimers();
    whyIdx = 0;
    whyReasons.forEach(function(el) { el.classList.remove('reason-spotlight', 'reason-all-on', 'reason-dim'); });
    whyReasons.forEach(function(el, i) {
      whyEnterTimers.push(setTimeout(function() { el.classList.add('reason-dim'); }, 100 + i * 120));
    });
    whyEnterTimers.push(setTimeout(function() { setWhyStep(1); }, 100 + whyReasons.length * 120 + 200));
  }

  function resetWhy() {
    clearWhyEnterTimers();
    whyIdx = 0;
    whyReasons.forEach(function(el) {
      el.classList.remove('reason-spotlight', 'reason-all-on', 'reason-dim');
    });
  }

  // Wrap navigateTo to handle chapter-specific state
  var origNavigateTo = navigateTo;
  navigateTo = function(idx) {
    origNavigateTo(idx);
    // Reset architecture phase when arriving at architecture chapter.
    // When leaving, cancel any in-flight Step 2 timers so they don't keep
    // firing in the background and corrupt the state on the next return.
    if (idx === ARCH_CHAPTER) {
      setArchPhase(0);
      setTimeout(typeArchSubtitle, 300);
    } else {
      clearArchStepTimers();
      if (archLabel) archLabel.classList.remove('visible');
    }
    // Reset benefit panels to first when arriving at benefits chapter
    if (idx === BENEFITS_CHAPTER) {
      expandBenefitPanel(0);
    }
    // Why slide: start at reason 1 on arrival; clear state when leaving.
    if (idx === WHY_CHAPTER) {
      setTimeout(enterWhy, 300);
    } else {
      resetWhy();
    }
    // Start typed hostname when reaching CTA slide
    if (idx === totalChapters - 1 && !typedStarted) {
      typedStarted = true;
      setTimeout(typeHostname, 600);
    }
  };

})();

// ── Interactive Lifecycle Wheel with Connectors ──────
(function() {
  var wheel = document.getElementById('lifecycleWheel');
  if (!wheel) return;

  var capabilities = [
    { id: 'issue', name: 'Issue &\nDeploy', angle: -90, color: '#0F62FE' },
    { id: 'monitor', name: 'Monitor', angle: -18, color: '#009D9A' },
    { id: 'renew', name: 'Renew', angle: 54, color: '#198038' },
    { id: 'revoke', name: 'Revoke', angle: 126, color: '#DA1E28' },
    { id: 'rollback', name: 'Rollback', angle: 198, color: '#B28600' },
  ];

  var cx = 250, cy = 250, r = 160;
  var ns = 'http://www.w3.org/2000/svg';

  // Draw connector lines from center to each node
  var connectorsG = wheel.querySelector('#connectorLines');
  var connectorElements = [];

  capabilities.forEach(function(cap) {
    var a = cap.angle * Math.PI / 180;
    var nx = cx + r * Math.cos(a);
    var ny = cy + r * Math.sin(a);

    // Main connector line
    var line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', cx);
    line.setAttribute('y1', cy);
    line.setAttribute('x2', nx);
    line.setAttribute('y2', ny);
    line.classList.add('connector-line');
    line.setAttribute('stroke', cap.color);
    line.setAttribute('data-cap', cap.id);
    line.style.setProperty('--line-color', cap.color);
    line.style.opacity = '0.3';
    connectorsG.appendChild(line);

    // Animated particle dots along the line
    for (var p = 0; p < 3; p++) {
      var particle = document.createElementNS(ns, 'circle');
      particle.setAttribute('r', '3');
      particle.setAttribute('fill', cap.color);
      particle.classList.add('connector-particle');
      particle.setAttribute('data-cap', cap.id);
      // Position particles along the line
      var t = 0.25 + p * 0.25;
      particle.setAttribute('cx', cx + (nx - cx) * t);
      particle.setAttribute('cy', cy + (ny - cy) * t);
      particle.style.opacity = '0';
      connectorsG.appendChild(particle);
    }

    connectorElements.push({ line: line, cap: cap.id, nx: nx, ny: ny });
  });

  // Draw dashed arc connectors
  var arcsG = wheel.querySelector('#arcs');
  capabilities.forEach(function(cap, i) {
    var next = capabilities[(i + 1) % capabilities.length];
    var a1 = (cap.angle + 16) * Math.PI / 180;
    var a2 = (next.angle - 16) * Math.PI / 180;
    var x1 = cx + (r + 5) * Math.cos(a1);
    var y1 = cy + (r + 5) * Math.sin(a1);
    var x2 = cx + (r + 5) * Math.cos(a2);
    var y2 = cy + (r + 5) * Math.sin(a2);
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' A ' + (r + 5) + ' ' + (r + 5) + ' 0 0 1 ' + x2 + ' ' + y2);
    path.setAttribute('stroke', 'oklch(75% 0.008 55)');
    arcsG.appendChild(path);
  });

  // Helper to activate/deactivate connector visuals
  function setConnectorState(capId, state) {
    wheel.querySelectorAll('.connector-line[data-cap="' + capId + '"]').forEach(function(el) {
      el.classList.toggle('active', state === 'active');
      el.classList.toggle('hovered', state === 'hovered');
      el.style.opacity = (state === 'active' || state === 'hovered') ? '1' : '0.3';
      el.setAttribute('stroke-width', (state === 'active' || state === 'hovered') ? '3' : '1.5');
    });
    wheel.querySelectorAll('.connector-particle[data-cap="' + capId + '"]').forEach(function(el) {
      el.classList.toggle('active', state === 'active');
      el.classList.toggle('hovered', state === 'hovered');
      el.style.opacity = (state === 'active' || state === 'hovered') ? '0.8' : '0';
    });
  }

  // Particle animation — runs continuously; browser auto-pauses rAF on backgrounded tabs.
  var particlePhase = 0;
  function animateParticles() {
    particlePhase += 0.002;
    wheel.querySelectorAll('.connector-particle').forEach(function(el) {
      if (el.style.opacity === '0') return;
      var capId = el.getAttribute('data-cap');
      var cap = capabilities.find(function(c) { return c.id === capId; });
      if (!cap) return;
      var a = cap.angle * Math.PI / 180;
      var nx = cx + r * Math.cos(a);
      var ny = cy + r * Math.sin(a);
      var siblings = wheel.querySelectorAll('.connector-particle[data-cap="' + capId + '"]');
      var idx = Array.prototype.indexOf.call(siblings, el);
      var t = ((particlePhase + idx * 0.33) % 1);
      el.setAttribute('cx', cx + (nx - cx) * t);
      el.setAttribute('cy', cy + (ny - cy) * t);
      el.setAttribute('r', 2.5 + Math.sin(t * Math.PI) * 3);
      el.style.opacity = String(Math.sin(t * Math.PI) * 0.9);
    });
    requestAnimationFrame(animateParticles);
  }
  animateParticles();

  // Create interactive nodes
  capabilities.forEach(function(cap, i) {
    var a = cap.angle * Math.PI / 180;
    var nx = cx + r * Math.cos(a);
    var ny = cy + r * Math.sin(a);

    var g = document.createElementNS(ns, 'g');
    g.classList.add('lifecycle-node');
    g.dataset.cap = cap.id;
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    g.setAttribute('aria-label', cap.name.replace(/\n/g, ' ') + ' capability');
    if (i === 0) {
      g.classList.add('active');
      setConnectorState(cap.id, 'active');
    }

    // Outer glow
    var bg = document.createElementNS(ns, 'circle');
    bg.classList.add('node-bg');
    bg.setAttribute('cx', nx);
    bg.setAttribute('cy', ny);
    bg.setAttribute('r', 48);
    bg.setAttribute('fill', cap.color);
    g.appendChild(bg);

    // Ring
    var ring = document.createElementNS(ns, 'circle');
    ring.classList.add('node-ring');
    ring.setAttribute('cx', nx);
    ring.setAttribute('cy', ny);
    ring.setAttribute('r', 40);
    ring.setAttribute('fill', 'white');
    ring.setAttribute('stroke', cap.color);
    ring.setAttribute('stroke-width', i === 0 ? '5' : '2.5');
    g.appendChild(ring);

    // Text
    var lines = cap.name.split('\n');
    lines.forEach(function(line, li) {
      var text = document.createElementNS(ns, 'text');
      text.setAttribute('x', nx);
      text.setAttribute('y', ny + (lines.length === 1 ? 1 : (li === 0 ? -7 : 10)));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', lines.length === 1 ? 'middle' : 'auto');
      text.setAttribute('font-family', 'IBM Plex Sans, sans-serif');
      text.setAttribute('font-weight', '700');
      text.setAttribute('font-size', '14');
      text.setAttribute('fill', cap.color);
      text.textContent = line;
      g.appendChild(text);
    });

    // Hover handlers for connector glow
    g.addEventListener('mouseenter', function() {
      if (!g.classList.contains('active')) {
        setConnectorState(cap.id, 'hovered');
      }
    });
    g.addEventListener('mouseleave', function() {
      if (!g.classList.contains('active')) {
        setConnectorState(cap.id, 'off');
      }
    });

    // Click handler
    g.addEventListener('click', function() {
      // Deactivate all
      wheel.querySelectorAll('.lifecycle-node').forEach(function(n) {
        n.classList.remove('active');
        n.querySelector('.node-ring').setAttribute('stroke-width', '2.5');
        setConnectorState(n.dataset.cap, 'off');
      });
      document.querySelectorAll('.lifecycle-detail-panel').forEach(function(p) {
        p.classList.remove('active');
      });

      // Activate clicked
      g.classList.add('active');
      ring.setAttribute('stroke-width', '5');
      setConnectorState(cap.id, 'active');
      var panel = document.querySelector('.lifecycle-detail-panel[data-cap="' + cap.id + '"]');
      if (panel) panel.classList.add('active');
    });

    // Keyboard activation (Enter or Space)
    g.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        g.dispatchEvent(new Event('click', { bubbles: true }));
      }
    });

    wheel.appendChild(g);
  });

  // Auto-rotate through capabilities every 5 seconds
  var autoTimer;
  var currentIdx = 0;
  var userInteracted = false;

  function autoAdvance() {
    if (userInteracted) return;
    currentIdx = (currentIdx + 1) % capabilities.length;
    var node = wheel.querySelector('.lifecycle-node[data-cap="' + capabilities[currentIdx].id + '"]');
    if (node) node.click();
  }

  autoTimer = setInterval(autoAdvance, 7500);

  wheel.addEventListener('click', function() {
    userInteracted = true;
    clearInterval(autoTimer);
    setTimeout(function() { userInteracted = false; autoTimer = setInterval(autoAdvance, 7500); }, 15000);
  });
})();
