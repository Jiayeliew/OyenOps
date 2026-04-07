// ============================================================
// BakeryOps Dashboard — Code.gs (Google Apps Script Backend)
// ============================================================
// IMPORTANT: After every new deployment, copy the new Web App URL
// and update SHEET_URL in index.html before uploading to GitHub.
// ============================================================

const SPREADSHEET_ID = '142jMRGzgfI5JqFltZXdXZukluKwVs4h-ob6D3c7Jm8Y'; // ← replace with your Sheet ID
const SS = SpreadsheetApp.openById(SPREADSHEET_ID);

// ── Sheet helpers ────────────────────────────────────────────
function sheet(name) { return SS.getSheetByName(name); }
function sheetData(name) {
  const s = sheet(name);
  const vals = s.getDataRange().getValues();
  if (vals.length < 2) return [];
  const headers = vals[0];
  return vals.slice(1).map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i]]))
  );
}
function appendRow(name, rowArr) {
  sheet(name).appendRow(rowArr);
}
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function fmtTime(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'HH:mm:ss');
}
function today() { return fmtDate(new Date()); }

// ── CORS / Router ────────────────────────────────────────────
function doGet(e) {
  const action = e.parameter.action;
  let result;
  try {
    result = route(action, e.parameter, null);
  } catch (err) {
    result = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let params = {};
  try { params = JSON.parse(e.postData.contents); } catch (_) {}
  const action = params.action || e.parameter.action;
  let result;
  try {
    result = route(action, e.parameter, params);
  } catch (err) {
    result = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function route(action, get, post) {
  const p = post || get || {};
  switch (action) {
    // Auth & Staff
    case 'getStaffList':       return getStaffList();
    case 'getStaff':           return getStaff(p.staffId);
    case 'getConfig':          return getConfig();

    // Attendance
    case 'clockIn':            return clockIn(p);
    case 'clockOut':           return clockOut(p);
    case 'getTodayAttendance': return getTodayAttendance(p.staffId);
    case 'getAttendanceHistory': return getAttendanceHistory(p.staffId, p.month);

    // Schedule
    case 'getSchedule':        return getSchedule(p.staffId, p.weekStart);
    case 'getAllSchedule':      return getAllSchedule(p.weekStart);
    case 'saveSchedule':       return saveSchedule(p);

    // Tasks
    case 'getTasks':           return getTasks(p.date, p.shift);
    case 'completeTask':       return completeTask(p);
    case 'getTaskTemplates':   return getTaskTemplates();
    case 'saveTaskTemplate':   return saveTaskTemplate(p);

    // Handover
    case 'getHandover':        return getHandover(p.date);
    case 'submitHandover':     return submitHandover(p);

    // Sales
    case 'getSales':           return getSales(p.staffId, p.month);
    case 'submitSales':        return submitSales(p);
    case 'getAllSales':         return getAllSales(p.month);

    // Waste
    case 'getWaste':           return getWaste(p.staffId, p.date);
    case 'submitWaste':        return submitWaste(p);
    case 'getAllWaste':         return getAllWaste(p.month);

    // My Dashboard
    case 'getMyDashboard':     return getMyDashboard(p.staffId, p.month);
    case 'getAllDashboard':    return getAllDashboard(p.month);

    // Leave
    case 'getLeaveBalance':    return getLeaveBalance(p.staffId);
    case 'getLeaveHistory':    return getLeaveHistory(p.staffId);
    case 'applyLeave':         return applyLeave(p);
    case 'getPendingLeave':    return getPendingLeave();
    case 'updateLeave':        return updateLeave(p);
    case 'getHolidays':        return getHolidays();

    // Announcements
    case 'getAnnouncements':   return getAnnouncements();
    case 'postAnnouncement':   return postAnnouncement(p);
    case 'acknowledgeAnnouncement': return acknowledgeAnnouncement(p);

    // Payroll
    case 'getPayroll':         return getPayroll(p.staffId, p.month);
    case 'getAllPayroll':       return getAllPayroll(p.month);

    // Drive photo upload
    case 'uploadPhoto':        return uploadPhoto(p);

    default: return { error: 'Unknown action: ' + action };
  }
}

// ── STAFF ────────────────────────────────────────────────────
function getStaffList() {
  return sheetData('STAFF').filter(r => r['Status'] === 'active').map(r => ({
    id: r['Staff ID'], name: r['Name'], role: r['Role'], position: r['Position / Title']
  }));
}

function getStaff(staffId) {
  const all = sheetData('STAFF');
  return all.find(r => r['Staff ID'] == staffId) || { error: 'Not found' };
}

function getConfig() {
  const rows = sheetData('CONFIG');
  const cfg = {};
  rows.forEach(r => { cfg[r['Key']] = r['Value']; });
  return cfg;
}

// ── ATTENDANCE ───────────────────────────────────────────────
function clockIn(p) {
  const now = new Date();
  const todayStr = today();
  const timeStr = fmtTime(now);
  const att = sheetData('ATTENDANCE');
  const existing = att.find(r => fmtDate(r['Date']) === todayStr && r['Staff ID'] == p.staffId);
  if (existing) return { error: 'Already clocked in today' };

  // Get schedule to check late
  const schedule = sheetData('SCHEDULE');
  const todaySched = schedule.find(r =>
    fmtDate(r['Date']) === todayStr && r['Staff ID'] == p.staffId
  );
  const shift = todaySched ? todaySched['Shift'] : '';
  const scheduledStart = todaySched ? todaySched['Scheduled Start Time'] || '' : '';
  const scheduledEnd = todaySched ? todaySched['Scheduled End Time'] || '' : '';

  // Late check
  const cfg = getConfig();
  const threshold = parseInt(cfg['late_threshold_minutes'] || '5');
  let lateFlag = 'No', lateMinutes = 0;
  if (scheduledStart) {
    const [sh, sm] = scheduledStart.split(':').map(Number);
    const scheduled = new Date(now); scheduled.setHours(sh, sm, 0, 0);
    const diff = Math.floor((now - scheduled) / 60000);
    if (diff > threshold) { lateFlag = 'Yes'; lateMinutes = diff; }
  }

  // Photo URL (optional)
  const photoUrl = p.photoUrl || '';

  appendRow('ATTENDANCE', [
    todayStr, p.staffId, p.staffName, shift,
    scheduledStart, scheduledEnd,
    timeStr, '', photoUrl, '', '', lateFlag, lateMinutes, 'No', ''
  ]);
  return { success: true, time: timeStr, lateFlag, lateMinutes, shift, scheduledStart, scheduledEnd };
}

function clockOut(p) {
  const now = new Date();
  const todayStr = today();
  const timeStr = fmtTime(now);
  const s = sheet('ATTENDANCE');
  const data = s.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (fmtDate(data[i][0]) === todayStr && data[i][1] == p.staffId) {
      // Col H = index 7 (clock out), Col J = index 9 (photo), Col K = index 10 (hours)
      const clockIn = data[i][6];
      let hoursWorked = '';
      if (clockIn) {
        const inTime = new Date(todayStr + 'T' + clockIn);
        hoursWorked = ((now - inTime) / 3600000).toFixed(2);
      }
      // Early leave check
      const scheduledEnd = data[i][5];
      let earlyLeave = 'No';
      if (scheduledEnd) {
        const [eh, em] = String(scheduledEnd).split(':').map(Number);
        const endTime = new Date(now); endTime.setHours(eh, em, 0, 0);
        if (now < endTime) earlyLeave = 'Yes';
      }
      s.getRange(i + 1, 8).setValue(timeStr);          // H: clock out
      if (p.photoUrl) s.getRange(i + 1, 10).setValue(p.photoUrl); // J: out selfie
      s.getRange(i + 1, 11).setValue(hoursWorked);     // K: hours
      s.getRange(i + 1, 14).setValue(earlyLeave);      // N: early leave
      return { success: true, time: timeStr, hoursWorked, earlyLeave };
    }
  }
  return { error: 'No clock-in record found for today' };
}

function getTodayAttendance(staffId) {
  const att = sheetData('ATTENDANCE');
  return att.find(r => fmtDate(r['Date']) === today() && r['Staff ID'] == staffId) || null;
}

function getAttendanceHistory(staffId, month) {
  const att = sheetData('ATTENDANCE');
  return att.filter(r => r['Staff ID'] == staffId && String(fmtDate(r['Date'])).startsWith(month || ''));
}

// ── SCHEDULE ─────────────────────────────────────────────────
function getSchedule(staffId, weekStart) {
  const rows = sheetData('SCHEDULE');
  return rows.filter(r =>
    r['Staff ID'] == staffId &&
    (!weekStart || fmtDate(r['Week Start Date']) === weekStart)
  );
}

function getAllSchedule(weekStart) {
  const rows = sheetData('SCHEDULE');
  return weekStart ? rows.filter(r => fmtDate(r['Week Start Date']) === weekStart) : rows;
}

function saveSchedule(p) {
  // p.rows = array of schedule row objects to append/update
  const s = sheet('SCHEDULE');
  if (p.rows && Array.isArray(p.rows)) {
    p.rows.forEach(r => {
      appendRow('SCHEDULE', [
        r.weekStart, r.dayOfWeek, r.date, r.shift,
        r.staffId, r.staffName, r.status || 'scheduled'
      ]);
    });
  }
  return { success: true };
}

// ── TASKS ────────────────────────────────────────────────────
function getTasks(date, shift) {
  const rows = sheetData('TASKS');
  const d = date || today();
  return rows.filter(r => fmtDate(r['Date']) === d && (!shift || r['Shift'] === shift));
}

function completeTask(p) {
  const s = sheet('TASKS');
  const data = s.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (fmtDate(data[i][0]) === (p.date || today()) &&
        data[i][3] === p.taskDescription &&
        data[i][1] === p.shift) {
      s.getRange(i + 1, 5).setValue('Yes');
      s.getRange(i + 1, 6).setValue(p.staffId);
      s.getRange(i + 1, 7).setValue(fmtTime(new Date()));
      return { success: true };
    }
  }
  // If task doesn't exist yet for today, append it
  appendRow('TASKS', [
    p.date || today(), p.shift, p.category, p.taskDescription,
    'Yes', p.staffId, fmtTime(new Date())
  ]);
  return { success: true };
}

function getTaskTemplates() {
  try {
    const rows = sheetData('TASK_TEMPLATES');
    return rows;
  } catch (_) { return []; }
}

function saveTaskTemplate(p) {
  appendRow('TASK_TEMPLATES', [p.shift, p.category, p.description]);
  return { success: true };
}

// ── HANDOVER ─────────────────────────────────────────────────
function getHandover(date) {
  const rows = sheetData('HANDOVER');
  const d = date || today();
  return rows.filter(r => fmtDate(r['Date']) === d);
}

function submitHandover(p) {
  appendRow('HANDOVER', [
    today(), p.fromShift, p.fromStaffName, p.toShift,
    p.notes, new Date().toISOString()
  ]);
  return { success: true };
}

// ── SALES ────────────────────────────────────────────────────
function getSales(staffId, month) {
  const rows = sheetData('SALES');
  return rows.filter(r =>
    r['Staff ID'] == staffId &&
    (!month || String(fmtDate(r['Date'])).startsWith(month))
  );
}

function submitSales(p) {
  // Check if entry already exists for today
  const s = sheet('SALES');
  const data = s.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (fmtDate(data[i][0]) === today() &&
        data[i][1] == p.staffId &&
        data[i][3] === p.shift) {
      s.getRange(i + 1, 5).setValue(p.amount);
      s.getRange(i + 1, 6).setValue(p.notes || '');
      return { success: true, updated: true };
    }
  }
  appendRow('SALES', [today(), p.staffId, p.staffName, p.shift, p.amount, p.notes || '']);
  return { success: true };
}

function getAllSales(month) {
  const rows = sheetData('SALES');
  return month ? rows.filter(r => String(fmtDate(r['Date'])).startsWith(month)) : rows;
}

// ── WASTE ────────────────────────────────────────────────────
function getWaste(staffId, date) {
  const rows = sheetData('WASTE');
  const d = date || today();
  return rows.filter(r =>
    fmtDate(r['Date']) === d &&
    (!staffId || r['Staff ID'] == staffId)
  );
}

function submitWaste(p) {
  appendRow('WASTE', [
    today(), p.staffId, p.staffName,
    p.productName, p.quantity, p.reason,
    p.estimatedCost || 0, p.notes || ''
  ]);
  return { success: true };
}

function getAllWaste(month) {
  const rows = sheetData('WASTE');
  return month ? rows.filter(r => String(fmtDate(r['Date'])).startsWith(month)) : rows;
}

// ── MY DASHBOARD ─────────────────────────────────────────────
function getMyDashboard(staffId, month) {
  const m = month || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  const att = sheetData('ATTENDANCE').filter(r => r['Staff ID'] == staffId && String(fmtDate(r['Date'])).startsWith(m));
  const tasks = sheetData('TASKS').filter(r => r['Completed By'] == staffId && String(fmtDate(r['Date'])).startsWith(m));
  const sales = sheetData('SALES').filter(r => r['Staff ID'] == staffId && String(fmtDate(r['Date'])).startsWith(m));
  const staff = getStaff(staffId);
  const cfg = getConfig();
  const leave = sheetData('LEAVE').filter(r => r['Staff ID'] == staffId && r['Status'] === 'approved');
  const holidays = sheetData('HOLIDAYS');

  const daysWorked = att.filter(r => r['Actual Clock In']).length;
  const totalHours = att.reduce((sum, r) => sum + (parseFloat(r['Hours Worked']) || 0), 0);
  const lateCount = att.filter(r => r['Late Flag'] === 'Yes').length;
  const taskDays = [...new Set(tasks.filter(r => r['Completed'] === 'Yes').map(r => fmtDate(r['Date'])))].length;
  const salesTotal = sales.reduce((sum, r) => sum + (parseFloat(r['Sales Amount (RM)']) || 0), 0);

  const baseSalary = parseFloat(staff['Base Salary (monthly)']) || 0;
  const commRate = parseFloat(staff['Commission Rate (%)']) || 0;
  const taskRewardPerDay = parseFloat(cfg['task_reward_per_day'] || '10');
  const taskReward = taskDays * taskRewardPerDay;
  const commission = salesTotal * commRate / 100;

  // AL/MC balance
  const alTaken = leave.filter(r => r['Leave Type'] === 'AL').reduce((s, r) => s + (parseInt(r['Days']) || 0), 0);
  const mcTaken = leave.filter(r => r['Leave Type'] === 'MC').reduce((s, r) => s + (parseInt(r['Days']) || 0), 0);
  const alTotal = parseFloat(staff['AL Entitlement (days/year)']) || parseFloat(cfg['al_default_days'] || '8');
  const mcTotal = parseFloat(staff['MC Entitlement (days/year)']) || parseFloat(cfg['mc_default_days'] || '14');

  // Unpaid leave deductions
  const unpaidDays = leave.filter(r => r['Leave Type'] === 'Unpaid' && String(r['Start Date']).startsWith(m))
    .reduce((s, r) => s + (parseInt(r['Days']) || 0), 0);
  const workingDaysInMonth = 26; // approx
  const dailyRate = baseSalary / workingDaysInMonth;
  const deductions = unpaidDays * dailyRate;
  const grossPay = baseSalary + taskReward + commission - deductions;

  return {
    month: m, daysWorked, totalHours: totalHours.toFixed(1), lateCount,
    taskDays, salesTotal, commission, baseSalary, taskReward,
    commissionRate: commRate, grossPay, deductions,
    alRemaining: alTotal - alTaken, mcRemaining: mcTotal - mcTaken,
    alTaken, mcTaken, alTotal, mcTotal,
    salesTarget: parseFloat(cfg['monthly_sales_target'] || '50000')
  };
}

function getAllDashboard(month) {
  const staff = sheetData('STAFF').filter(r => r['Status'] === 'active');
  return staff.map(s => getMyDashboard(s['Staff ID'], month));
}

// ── LEAVE ────────────────────────────────────────────────────
function getLeaveBalance(staffId) {
  const staff = getStaff(staffId);
  const cfg = getConfig();
  const leave = sheetData('LEAVE').filter(r => r['Staff ID'] == staffId && r['Status'] === 'approved');
  const alTotal = parseFloat(staff['AL Entitlement (days/year)']) || parseFloat(cfg['al_default_days'] || '8');
  const mcTotal = parseFloat(staff['MC Entitlement (days/year)']) || parseFloat(cfg['mc_default_days'] || '14');
  const alTaken = leave.filter(r => r['Leave Type'] === 'AL').reduce((s, r) => s + (parseInt(r['Days']) || 0), 0);
  const mcTaken = leave.filter(r => r['Leave Type'] === 'MC').reduce((s, r) => s + (parseInt(r['Days']) || 0), 0);
  return { alTotal, mcTotal, alTaken, mcTaken, alRemaining: alTotal - alTaken, mcRemaining: mcTotal - mcTaken };
}

function getLeaveHistory(staffId) {
  return sheetData('LEAVE').filter(r => r['Staff ID'] == staffId);
}

function applyLeave(p) {
  const reqId = 'LV' + Date.now();
  const start = new Date(p.startDate);
  const end = new Date(p.endDate);
  const days = Math.ceil((end - start) / 86400000) + 1;
  appendRow('LEAVE', [
    reqId, p.staffId, p.staffName, p.leaveType,
    p.startDate, p.endDate, days, p.reason,
    'pending', '', '', p.attachmentUrl || ''
  ]);
  return { success: true, reqId, days };
}

function getPendingLeave() {
  return sheetData('LEAVE').filter(r => r['Status'] === 'pending');
}

function updateLeave(p) {
  const s = sheet('LEAVE');
  const data = s.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] == p.reqId) {
      s.getRange(i + 1, 9).setValue(p.status);    // I: status
      s.getRange(i + 1, 10).setValue(p.approvedBy);// J: approved by
      s.getRange(i + 1, 11).setValue(today());      // K: approved date
      return { success: true };
    }
  }
  return { error: 'Leave request not found' };
}

function getHolidays() {
  return sheetData('HOLIDAYS');
}

// ── ANNOUNCEMENTS ────────────────────────────────────────────
function getAnnouncements() {
  const rows = sheetData('ANNOUNCEMENTS');
  return rows.sort((a, b) => {
    if (a['Priority'] === 'urgent' && b['Priority'] !== 'urgent') return -1;
    if (b['Priority'] === 'urgent' && a['Priority'] !== 'urgent') return 1;
    return new Date(b['Date']) - new Date(a['Date']);
  });
}

function postAnnouncement(p) {
  appendRow('ANNOUNCEMENTS', [today(), p.postedBy, p.title, p.content, p.priority || 'normal', '']);
  return { success: true };
}

function acknowledgeAnnouncement(p) {
  const s = sheet('ANNOUNCEMENTS');
  const data = s.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][2] === p.title && fmtDate(data[i][0]) === p.date) {
      const existing = String(data[i][5] || '');
      const ids = existing ? existing.split(',').map(x => x.trim()) : [];
      if (!ids.includes(String(p.staffId))) {
        ids.push(String(p.staffId));
        s.getRange(i + 1, 6).setValue(ids.join(', '));
      }
      return { success: true };
    }
  }
  return { error: 'Announcement not found' };
}

// ── PAYROLL ──────────────────────────────────────────────────
function getPayroll(staffId, month) {
  const rows = sheetData('PAYROLL');
  return rows.filter(r => r['Staff ID'] == staffId && (!month || String(r['Month']).startsWith(month)));
}

function getAllPayroll(month) {
  const rows = sheetData('PAYROLL');
  return month ? rows.filter(r => String(r['Month']).startsWith(month)) : rows;
}

// ── DRIVE PHOTO UPLOAD ───────────────────────────────────────
function uploadPhoto(p) {
  // p.base64 = base64 image string, p.filename = filename, p.folder = subfolder
  const folder = getOrCreateFolder(p.folder || 'Selfies/' + today());
  const blob = Utilities.newBlob(
    Utilities.base64Decode(p.base64.replace(/^data:image\/\w+;base64,/, '')),
    'image/jpeg',
    p.filename || 'photo.jpg'
  );
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { success: true, url: file.getUrl(), id: file.getId() };
}

function getOrCreateFolder(path) {
  const parts = ('BakeryOps/' + path).split('/');
  let current = DriveApp.getRootFolder();
  parts.forEach(part => {
    if (!part) return;
    const folders = current.getFoldersByName(part);
    current = folders.hasNext() ? folders.next() : current.createFolder(part);
  });
  return current;
}

// ── One-time auth helper ─────────────────────────────────────
function authorizeDrive() {
  DriveApp.getRootFolder(); // triggers OAuth consent for Drive
  Logger.log('Drive authorized.');
}

// ── Seed today's tasks from templates (run via trigger or manually) ──
function seedDailyTasks() {
  const todayStr = today();
  const existing = getTasks(todayStr, null);
  if (existing.length > 0) return; // already seeded

  const templates = getTaskTemplates();
  templates.forEach(t => {
    ['morning', 'evening'].forEach(shift => {
      if (!t['Shift'] || t['Shift'] === shift) {
        appendRow('TASKS', [todayStr, shift, t['Category'] || t['Task Category'], t['Description'] || t['Task Description'], 'No', '', '']);
      }
    });
  });
}
