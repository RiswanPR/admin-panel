/**
 * Zeitnah LMS — Gamification & Leaderboard Frontend Interactivity
 */

(function () {
  'use strict';

  let currentStudentId = null;
  let currentStudentBalance = 0;
  let currentEnrolledCourses = [];
  let currentScope = 'global';
  let currentMode = 'award'; // 'award' or 'adjust'
  let searchTimeout = null;

  // Generate unique idempotency key
  function generateTransactionKey() {
    return 'tx-' + Date.now() + '-' + Math.random().toString(36).substring(2, 11);
  }

  // Open Award / Adjust Points Modal
  window.openAwardPointsModal = async function (options = {}) {
    const modalEl = document.getElementById('awardPointsModal');
    if (!modalEl) return;

    // Reposition to body to avoid stacking context / backdrop clipping
    if (modalEl.parentNode !== document.body) {
      document.body.appendChild(modalEl);
    }

    // Support passing HTMLElement directly (e.g. from onclick="openAwardPointsModal(this)")
    if (options instanceof HTMLElement) {
      const el = options;
      options = {
        studentId: el.getAttribute('data-student-id') || null,
        studentName: el.getAttribute('data-student-name') || 'Student',
        studentUsername: el.getAttribute('data-student-username') || '',
        currentBalance: Number(el.getAttribute('data-current-balance')) || 0,
        mode: el.getAttribute('data-mode') || 'award',
        scope: el.getAttribute('data-scope') || 'global',
      };
    }

    currentStudentId = options.studentId || null;
    currentStudentBalance = Number(options.currentBalance) || 0;
    currentMode = options.mode || 'award';
    currentScope = options.scope || 'global';

    // Reset Form Fields
    const modalTitle = document.getElementById('awardModalTitle');
    const studentSearchInput = document.getElementById('studentSearchInput');
    const selectedStudentCard = document.getElementById('selectedStudentCard');
    const selectedStudentName = document.getElementById('selectedStudentName');
    const selectedStudentUsername = document.getElementById('selectedStudentUsername');
    const pointsInput = document.getElementById('awardPointsInput');
    const reasonInput = document.getElementById('awardReasonInput');
    const submitBtn = document.getElementById('submitAwardBtn');
    const courseSelect = document.getElementById('courseSelectInput');
    const resultsContainer = document.getElementById('studentSearchResults');

    if (resultsContainer) {
      resultsContainer.style.display = 'none';
      resultsContainer.innerHTML = '';
    }

    if (modalTitle) {
      modalTitle.innerHTML = currentMode === 'award'
        ? '<i class="fa-solid fa-plus-circle text-success me-2"></i>Award XP / Points'
        : '<i class="fa-solid fa-minus-circle text-danger me-2"></i>Adjust / Deduct XP';
    }

    if (submitBtn) {
      submitBtn.textContent = currentMode === 'award' ? 'Award XP' : 'Deduct XP';
      submitBtn.className = currentMode === 'award' ? 'btn btn-success px-4 fw-bold' : 'btn btn-danger px-4 fw-bold';
      submitBtn.disabled = false;
    }

    if (pointsInput) pointsInput.value = '';
    if (reasonInput) reasonInput.value = '';

    // Scope toggle
    window.setPointScope(currentScope);

    // If student pre-selected
    if (currentStudentId) {
      if (studentSearchInput && studentSearchInput.parentElement) {
        studentSearchInput.parentElement.style.display = 'none';
      }
      if (selectedStudentCard) selectedStudentCard.style.display = 'flex';
      if (selectedStudentName) selectedStudentName.textContent = options.studentName || 'Student';
      if (selectedStudentUsername) selectedStudentUsername.textContent = options.studentUsername || '';

      await loadStudentCourses(currentStudentId);
    } else {
      if (studentSearchInput && studentSearchInput.parentElement) {
        studentSearchInput.parentElement.style.display = 'block';
        studentSearchInput.value = '';
      }
      if (selectedStudentCard) selectedStudentCard.style.display = 'none';
      currentEnrolledCourses = [];
      if (courseSelect) {
        courseSelect.innerHTML = '<option value="">Select student first...</option>';
      }
    }

    updateBalancePreview();

    // Show modal via Bootstrap / jQuery with full fallbacks
    if (window.jQuery && typeof window.jQuery.fn.modal === 'function') {
      window.jQuery(modalEl).modal('show');
    } else if (window.bootstrap && window.bootstrap.Modal && typeof window.bootstrap.Modal.getOrCreateInstance === 'function') {
      const bsModal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
      bsModal.show();
    } else {
      modalEl.classList.add('show');
      modalEl.style.display = 'block';
      document.body.classList.add('modal-open');
    }
  };

  // Close Award Points Modal safely
  window.closeAwardPointsModal = function () {
    const modalEl = document.getElementById('awardPointsModal');
    if (!modalEl) return;

    if (window.jQuery && typeof window.jQuery.fn.modal === 'function') {
      window.jQuery(modalEl).modal('hide');
    } else if (window.bootstrap && window.bootstrap.Modal && typeof window.bootstrap.Modal.getInstance === 'function') {
      const inst = window.bootstrap.Modal.getInstance(modalEl);
      if (inst) inst.hide();
    }

    modalEl.classList.remove('show');
    modalEl.style.display = 'none';
    document.body.classList.remove('modal-open');
    const backdrops = document.querySelectorAll('.modal-backdrop');
    backdrops.forEach(b => b.remove());
  };

  // Quick Points chip selector
  window.setAwardPointsValue = function (pts) {
    const pointsInput = document.getElementById('awardPointsInput');
    if (pointsInput) {
      pointsInput.value = pts;
      window.updateBalancePreview();
    }
  };

  // Quick Reason chip selector
  window.setAwardReasonValue = function (reason) {
    const reasonInput = document.getElementById('awardReasonInput');
    if (reasonInput) {
      reasonInput.value = reason;
    }
  };

  // Set Scope (Global vs Course)
  window.setPointScope = function (scope) {
    currentScope = scope;
    const globalBtn = document.getElementById('scopeGlobalBtn');
    const courseBtn = document.getElementById('scopeCourseBtn');
    const courseGroup = document.getElementById('courseSelectGroup');

    if (globalBtn && courseBtn) {
      if (scope === 'global') {
        globalBtn.classList.add('active');
        courseBtn.classList.remove('active');
        if (courseGroup) courseGroup.style.display = 'none';
      } else {
        courseBtn.classList.add('active');
        globalBtn.classList.remove('active');
        if (courseGroup) courseGroup.style.display = 'block';
      }
    }
  };

  // Load courses enrolled by a specific student
  async function loadStudentCourses(studentId) {
    const courseSelect = document.getElementById('courseSelectInput');
    if (!courseSelect) return;

    try {
      courseSelect.innerHTML = '<option value="">Loading enrolled courses...</option>';
      const res = await fetch(`/admin/points/student-courses/${studentId}`);
      const data = await res.json();

      if (data.success && Array.isArray(data.courses) && data.courses.length) {
        currentEnrolledCourses = data.courses;
        courseSelect.innerHTML =
          '<option value="">Choose an enrolled course...</option>' +
          data.courses
            .map(
              (c) => `<option value="${c.courseId}">${c.courseName}</option>`
            )
            .join('');
      } else {
        currentEnrolledCourses = [];
        courseSelect.innerHTML = '<option value="">No enrolled courses found for this student</option>';
      }
    } catch (err) {
      console.error('Failed to load student courses:', err);
      courseSelect.innerHTML = '<option value="">Failed to load courses</option>';
    }
  }

  // Live Balance Preview Calculation
  window.updateBalancePreview = function () {
    const pointsInput = document.getElementById('awardPointsInput');
    const currentBalanceEl = document.getElementById('previewCurrentBalance');
    const changeAmountEl = document.getElementById('previewChangeAmount');
    const afterBalanceEl = document.getElementById('previewAfterBalance');
    const balanceWarning = document.getElementById('previewBalanceWarning');

    const points = Math.max(0, parseInt(pointsInput?.value, 10) || 0);

    if (currentBalanceEl) currentBalanceEl.textContent = currentStudentBalance.toLocaleString() + ' XP';

    let afterBalance = currentStudentBalance;
    if (currentMode === 'award') {
      afterBalance = currentStudentBalance + points;
      if (changeAmountEl) {
        changeAmountEl.textContent = '+' + points.toLocaleString() + ' XP';
        changeAmountEl.style.color = '#10b981';
      }
      if (balanceWarning) balanceWarning.style.display = 'none';
    } else {
      afterBalance = Math.max(0, currentStudentBalance - points);
      if (changeAmountEl) {
        changeAmountEl.textContent = '-' + points.toLocaleString() + ' XP';
        changeAmountEl.style.color = '#ef4444';
      }
      if (balanceWarning) {
        balanceWarning.style.display = (points > currentStudentBalance) ? 'block' : 'none';
      }
    }

    if (afterBalanceEl) {
      afterBalanceEl.textContent = afterBalance.toLocaleString() + ' XP';
      if (currentMode === 'adjust' && points > currentStudentBalance) {
        afterBalanceEl.style.color = '#ef4444';
      } else {
        afterBalanceEl.style.color = '';
      }
    }
  };

  // Student Search in Modal Autocomplete
  window.searchStudentsInModal = function (query) {
    clearTimeout(searchTimeout);
    const resultsContainer = document.getElementById('studentSearchResults');
    if (!resultsContainer) return;

    if (!query || query.trim().length < 2) {
      resultsContainer.style.display = 'none';
      resultsContainer.innerHTML = '';
      return;
    }

    searchTimeout = setTimeout(async () => {
      try {
        const res = await fetch(`/admin/points/student-search?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json();

        if (data.success && Array.isArray(data.students) && data.students.length) {
          resultsContainer.innerHTML = '';
          data.students.forEach((s) => {
            const item = document.createElement('div');
            item.className = 'search-result-item d-flex align-items-center justify-content-between p-2 border-bottom';
            item.style.cursor = 'pointer';
            item.innerHTML = `
              <div class="d-flex align-items-center gap-2">
                <div class="avatar-sm rounded bg-dark text-white d-flex align-items-center justify-content-center" style="width:32px;height:32px;font-size:12px;font-weight:bold;">
                  ${s.initials || 'ST'}
                </div>
                <div>
                  <strong class="d-block" style="font-size:13px;">${s.name}</strong>
                  <small class="text-muted">${s.username ? '@' + s.username : s.email}</small>
                </div>
              </div>
              <span class="badge bg-secondary font-monospace">${(s.points || 0).toLocaleString()} XP</span>
            `;
            item.addEventListener('click', () => {
              window.selectStudentForModal(s._id, s.name, s.username || '', s.points || 0);
            });
            resultsContainer.appendChild(item);
          });
          resultsContainer.style.display = 'block';
        } else {
          resultsContainer.innerHTML = '<div class="p-3 text-muted text-center" style="font-size:13px;">No students found matching query</div>';
          resultsContainer.style.display = 'block';
        }
      } catch (err) {
        console.error('Student search failed:', err);
      }
    }, 250);
  };

  // Select student from search autocomplete
  window.selectStudentForModal = async function (id, name, username, points) {
    currentStudentId = id;
    currentStudentBalance = Number(points) || 0;

    const resultsContainer = document.getElementById('studentSearchResults');
    const selectedStudentCard = document.getElementById('selectedStudentCard');
    const selectedStudentName = document.getElementById('selectedStudentName');
    const selectedStudentUsername = document.getElementById('selectedStudentUsername');
    const studentSearchInput = document.getElementById('studentSearchInput');

    if (resultsContainer) resultsContainer.style.display = 'none';
    if (studentSearchInput && studentSearchInput.parentElement) {
      studentSearchInput.parentElement.style.display = 'none';
    }
    if (selectedStudentCard) selectedStudentCard.style.display = 'flex';
    if (selectedStudentName) selectedStudentName.textContent = name;
    if (selectedStudentUsername) selectedStudentUsername.textContent = username ? '@' + username : '';

    await loadStudentCourses(id);
    updateBalancePreview();
  };

  // Deselect student
  window.clearSelectedStudent = function () {
    currentStudentId = null;
    currentStudentBalance = 0;
    currentEnrolledCourses = [];

    const selectedStudentCard = document.getElementById('selectedStudentCard');
    const studentSearchInput = document.getElementById('studentSearchInput');
    const courseSelect = document.getElementById('courseSelectInput');

    if (selectedStudentCard) selectedStudentCard.style.display = 'none';
    if (studentSearchInput) {
      if (studentSearchInput.parentElement) studentSearchInput.parentElement.style.display = 'block';
      studentSearchInput.value = '';
      studentSearchInput.focus();
    }
    if (courseSelect) courseSelect.innerHTML = '<option value="">Select student first...</option>';

    updateBalancePreview();
  };

  // Submit Point Award / Deduction
  window.submitPointTransaction = async function () {
    if (!currentStudentId) {
      if (window.Swal) {
        Swal.fire({ icon: 'warning', title: 'Student Required', text: 'Please select a student to award or adjust points.' });
      } else {
        alert('Please select a student.');
      }
      return;
    }

    const pointsInput = document.getElementById('awardPointsInput');
    const reasonInput = document.getElementById('awardReasonInput');
    const courseSelect = document.getElementById('courseSelectInput');
    const submitBtn = document.getElementById('submitAwardBtn');

    const points = parseInt(pointsInput?.value, 10);
    const reason = String(reasonInput?.value || '').trim();
    const courseId = courseSelect?.value || null;

    if (!points || points <= 0) {
      if (window.Swal) {
        Swal.fire({ icon: 'warning', title: 'Invalid Points', text: 'Points must be a positive whole number greater than 0.' });
      } else {
        alert('Points must be a positive whole number greater than 0.');
      }
      return;
    }

    if (!reason) {
      if (window.Swal) {
        Swal.fire({ icon: 'warning', title: 'Reason Required', text: 'Please provide a justification for this point transaction.' });
      } else {
        alert('Please provide a reason.');
      }
      return;
    }

    if (currentScope === 'course' && !courseId) {
      if (window.Swal) {
        Swal.fire({ icon: 'warning', title: 'Course Required', text: 'Please select an enrolled course for course-scoped points.' });
      } else {
        alert('Please select a course.');
      }
      return;
    }

    if (currentMode === 'adjust' && points > currentStudentBalance) {
      if (window.Swal) {
        Swal.fire({
          icon: 'error',
          title: 'Insufficient Balance',
          text: `Cannot deduct ${points.toLocaleString()} XP. Student only has ${currentStudentBalance.toLocaleString()} XP.`,
        });
      } else {
        alert(`Cannot deduct more than current balance (${currentStudentBalance} XP).`);
      }
      return;
    }

    // Confirmation dialog before execution
    if (window.Swal) {
      const confirmResult = await Swal.fire({
        title: `${currentMode === 'award' ? 'Award' : 'Deduct'} ${points.toLocaleString()} XP?`,
        html: `
          <div class="text-start p-3 bg-light rounded" style="font-size:14px; color:#12314c;">
            <p class="mb-1"><strong>Scope:</strong> ${currentScope === 'course' ? 'Course XP' : 'Global XP'}</p>
            <p class="mb-1"><strong>Reason:</strong> ${reason}</p>
            <p class="mb-0"><strong>Balance:</strong> ${currentStudentBalance.toLocaleString()} XP &rarr; <strong>${(currentMode === 'award' ? currentStudentBalance + points : currentStudentBalance - points).toLocaleString()} XP</strong></p>
          </div>
        `,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: currentMode === 'award' ? 'Confirm Award' : 'Confirm Deduction',
        confirmButtonColor: currentMode === 'award' ? '#198754' : '#dc3545',
        cancelButtonText: 'Cancel',
      });

      if (!confirmResult.isConfirmed) return;
    }

    // Disable button to prevent double-submission
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-2"></i>Processing...';
    }

    const transactionKey = generateTransactionKey();
    const endpoint = currentMode === 'award' ? '/admin/points/award' : '/admin/points/adjust';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          studentId: currentStudentId,
          points,
          direction: currentMode === 'award' ? 'credit' : 'debit',
          scope: currentScope,
          courseId: currentScope === 'course' ? courseId : null,
          reason,
          transactionKey,
        }),
      });

      const data = await res.json();

      if (data.success) {
        window.closeAwardPointsModal();

        if (window.Swal) {
          if (data.levelUp) {
            Swal.fire({
              icon: 'success',
              title: 'LEVEL UP!',
              html: `
                <div class="py-2">
                  <p class="fs-5 fw-bold text-success mb-2">🎉 Level ${data.previousLevel} &rarr; Level ${data.newLevel}!</p>
                  <p class="text-muted mb-0">${points.toLocaleString()} XP ${currentMode === 'award' ? 'awarded' : 'adjusted'} successfully.</p>
                </div>
              `,
              timer: 3500,
              showConfirmButton: true,
            }).then(() => {
              window.location.reload();
            });
          } else {
            Swal.fire({
              icon: 'success',
              title: 'Points Updated',
              text: `${points.toLocaleString()} XP ${currentMode === 'award' ? 'awarded' : 'adjusted'} successfully.`,
              timer: 1800,
              showConfirmButton: false,
            }).then(() => {
              window.location.reload();
            });
          }
        } else {
          alert('Points updated successfully!');
          window.location.reload();
        }
      } else {
        if (window.Swal) {
          Swal.fire({ icon: 'error', title: 'Action Failed', text: data.message || 'Could not process transaction.' });
        } else {
          alert(data.message || 'Action failed.');
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = currentMode === 'award' ? 'Award XP' : 'Deduct XP';
        }
      }
    } catch (err) {
      console.error('Transaction error:', err);
      if (window.Swal) {
        Swal.fire({ icon: 'error', title: 'Network Error', text: 'Failed to communicate with server.' });
      } else {
        alert('Network error.');
      }
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = currentMode === 'award' ? 'Award XP' : 'Deduct XP';
      }
    }
  };

  // Filter / Search URL update with pagination preservation fix
  window.updateLeaderboardFilter = function (paramName, paramValue) {
    const url = new URL(window.location.href);

    if (paramValue !== undefined && paramValue !== null && String(paramValue).trim() !== '') {
      url.searchParams.set(paramName, String(paramValue).trim());
    } else {
      url.searchParams.delete(paramName);
    }

    // CRITICAL BUG FIX: Only reset to page 1 if changing a filter OTHER than page!
    if (paramName !== 'page') {
      url.searchParams.set('page', '1');
    }

    window.location.href = url.toString();
  };

  // Reset all filters
  window.resetLeaderboardFilters = function () {
    const url = new URL(window.location.href);
    url.searchParams.delete('search');
    url.searchParams.delete('level');
    url.searchParams.delete('rank');
    url.searchParams.delete('status');
    url.searchParams.delete('sort');
    url.searchParams.set('page', '1');
    window.location.href = url.toString();
  };

  // Debounced search field handler
  let debounceUrlTimeout = null;
  window.onSearchInputChange = function (input) {
    clearTimeout(debounceUrlTimeout);
    debounceUrlTimeout = setTimeout(() => {
      window.updateLeaderboardFilter('search', input.value);
    }, 450);
  };

  // Search input enter key handler
  window.onSearchInputKeydown = function (e, input) {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounceUrlTimeout);
      window.updateLeaderboardFilter('search', input.value);
    }
  };

  // Clear search input directly
  window.clearSearchInput = function () {
    window.updateLeaderboardFilter('search', '');
  };

  // Global event delegation for data-gamification-action buttons
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-gamification-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-gamification-action');
    if (action === 'award' || action === 'adjust') {
      e.preventDefault();
      window.openAwardPointsModal(btn);
    } else if (action === 'give-points') {
      e.preventDefault();
      window.openAwardPointsModal({ mode: 'award' });
    } else if (action === 'deduct-points') {
      e.preventDefault();
      window.openAwardPointsModal({ mode: 'adjust' });
    } else if (action === 'close-modal') {
      e.preventDefault();
      window.closeAwardPointsModal();
    }
  });

})();
