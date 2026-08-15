const STORAGE_KEY = 'engineer_form_persistent_state';
const STORAGE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour — PII auto-expires after this, even if the tab stays open

const COMPANIES_LIST_PAGE = "companieslist.html";
let companiesData = null;

// sha384 of pdfjs-dist@3.11.174/build/pdf.worker.min.js — computed from the actual npm package bytes.
const PDFJS_VERSION = "3.11.174";
const PDF_WORKER_SHA384_B64 = "SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2";

async function initPdfWorkerWithIntegrity() {
    if (!window.pdfjsLib) return;
    const workerUrl = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
    try {
        const resp = await fetch(workerUrl);
        if (!resp.ok) throw new Error(`Worker fetch failed with HTTP ${resp.status}`);
        const bytes = await resp.arrayBuffer();

        const digest = await crypto.subtle.digest('SHA-384', bytes);
        const digestB64 = btoa(String.fromCharCode(...new Uint8Array(digest)));

        if (digestB64 !== PDF_WORKER_SHA384_B64) {
            throw new Error('PDF.js worker file did not match the expected integrity hash. Refusing to load it.');
        }

        const workerBlob = new Blob([bytes], { type: 'application/javascript' });
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
    } catch (err) {
        console.error('PDF.js worker integrity check failed, falling back to direct URL:', err);
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    }
}

/* ------------------------------------------------------------
   Generation progress panel + button state control
   ------------------------------------------------------------ */
const GENERATION_BUTTON_IDS = ['btn-add-engineer', 'btn-reset-form', 'btn-submit-pdfs', 'btn-submit-email'];

function setGeneratingState(isGenerating) {
    const panel = document.getElementById('generation-status-panel');
    panel.classList.toggle('active', isGenerating);

    GENERATION_BUTTON_IDS.forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.disabled = isGenerating;
    });

    const pdfBtn = document.getElementById('btn-submit-pdfs');
    const emailBtn = document.getElementById('btn-submit-email');

    if (isGenerating) {
        if (pdfBtn && !pdfBtn.dataset.originalLabel) pdfBtn.dataset.originalLabel = pdfBtn.textContent;
        if (emailBtn && !emailBtn.dataset.originalLabel) emailBtn.dataset.originalLabel = emailBtn.textContent;
        if (pdfBtn) pdfBtn.innerHTML = '<span class="btn-spinner"></span>Generating...';
        if (emailBtn) emailBtn.innerHTML = '<span class="btn-spinner"></span>Generating...';
    } else {
        if (pdfBtn && pdfBtn.dataset.originalLabel) pdfBtn.textContent = pdfBtn.dataset.originalLabel;
        if (emailBtn && emailBtn.dataset.originalLabel) emailBtn.textContent = emailBtn.dataset.originalLabel;
        updateGenerationStatus('', 0);
    }
}

function updateGenerationStatus(text, percent) {
    const textEl = document.getElementById('generation-status-text');
    const fillEl = document.getElementById('generation-status-fill');
    if (textEl) textEl.textContent = text;
    if (fillEl) fillEl.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

function enforceNumericLimit(inputElement, maxLength = 10) {
    let digitsOnly = inputElement.value.replace(/\D/g, '');
    if (digitsOnly.length > maxLength) {
        digitsOnly = digitsOnly.slice(0, maxLength);
    }
    inputElement.value = digitsOnly;
}

function enforceMonthsLimit(inputElement) {
    let digitsOnly = inputElement.value.replace(/\D/g, '');
    if (digitsOnly.length > 2) {
        digitsOnly = digitsOnly.slice(0, 2);
    }
    if (digitsOnly !== '' && parseInt(digitsOnly, 10) > 12) {
        digitsOnly = '12';
    }
    inputElement.value = digitsOnly;
}

function getDetailedTimestamp() {
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const dd = pad(d.getDate());
    const mm = pad(d.getMonth() + 1);
    const yy = pad(d.getFullYear() % 100);
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${dd}${mm}${yy}${hh}${min}${ss}`;
}

function getDateDDMMMYY() {
    const d = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dd = d.getDate().toString().padStart(2, '0');
    const mmm = months[d.getMonth()];
    const yy = (d.getFullYear() % 100).toString().padStart(2, '0');
    return `${dd}${mmm}${yy}`;
}

function getDetailedTimestampDDMMMYY() {
    const d = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pad = (n) => n.toString().padStart(2, '0');
    const dd = pad(d.getDate());
    const mmm = months[d.getMonth()];
    const yy = pad(d.getFullYear() % 100);
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    const nn = pad(d.getSeconds());
    return `${dd}${mmm}${yy}${hh}${min}${nn}`;
}

function escapeHtml(value) {
    return (value ?? '').toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function chunkBase64(base64Str, chunkSize = 76) {
    const lines = [];
    for (let i = 0; i < base64Str.length; i += chunkSize) {
        lines.push(base64Str.slice(i, i + chunkSize));
    }
    return lines.join('\r\n');
}

function uint8ArrayToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000; 
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

function downloadEmlWithAttachments(subjectStr, htmlBodyStr, attachments, emlDownloadName) {
    const boundary = '----=_NextPart_' + Date.now().toString(36);
    const fullHtmlDoc = `<html><body style="font-family:Arial,sans-serif;font-size:13px;">${htmlBodyStr}</body></html>`;

    let emlContent =
        `To: \r\n` +
        `Subject: ${subjectStr}\r\n` +
        `X-Unsent: 1\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: text/html; charset="UTF-8"\r\n` +
        `Content-Transfer-Encoding: 8bit\r\n\r\n` +
        `${fullHtmlDoc}\r\n\r\n`;

    attachments.forEach(att => {
        emlContent +=
            `--${boundary}\r\n` +
            `Content-Type: ${att.mimeType}; name="${att.fileName}"\r\n` +
            `Content-Transfer-Encoding: base64\r\n` +
            `Content-Disposition: attachment; filename="${att.fileName}"\r\n\r\n` +
            `${chunkBase64(att.base64)}\r\n\r\n`;
    });

    emlContent += `--${boundary}--`;

    const emlBlob = new Blob([emlContent], { type: 'message/rfc822' });
    const emlLinkElement = document.createElement('a');
    emlLinkElement.href = URL.createObjectURL(emlBlob);
    emlLinkElement.download = emlDownloadName;
    document.body.appendChild(emlLinkElement);
    emlLinkElement.click();
    document.body.removeChild(emlLinkElement);
}

function downloadBytesAsFile(bytes, fileName, mimeType = 'application/pdf') {
    const blob = new Blob([bytes], { type: mimeType });
    const linkElement = document.createElement('a');
    linkElement.href = URL.createObjectURL(blob);
    linkElement.download = fileName;
    document.body.appendChild(linkElement);
    linkElement.click();
    document.body.removeChild(linkElement);
    URL.revokeObjectURL(linkElement.href);
}

async function loadCompaniesList() {
    try {
        const cacheBustedUrl = COMPANIES_LIST_PAGE + '?_=' + Date.now();
        const response = await fetch(cacheBustedUrl);
        if (!response.ok) {
            throw new Error('Could not fetch "' + COMPANIES_LIST_PAGE + '" (HTTP ' + response.status + ').');
        }
        const htmlText = await response.text();

        const parser = new DOMParser();
        const dataDoc = parser.parseFromString(htmlText, 'text/html');
        const table = dataDoc.getElementById('companiesTable');
        if (!table) {
            throw new Error('Could not find a table with id="companiesTable".');
        }

        const headerCells = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim().toLowerCase());
        const nameColIdx = headerCells.indexOf('company name');
        const idColIdx = headerCells.indexOf('company id');
        const voltageColIdx = headerCells.indexOf('voltage level');
        if (nameColIdx === -1 || idColIdx === -1) {
            throw new Error('Could not find "Company Name" and "Company ID" columns.');
        }

        const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
        if (bodyRows.length === 0) {
            throw new Error('The companiesTable has no data rows.');
        }

        companiesData = bodyRows.map(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
            return {
                name: cells[nameColIdx] || '',
                id: cells[idColIdx] || '',
                voltage: voltageColIdx !== -1 ? (cells[voltageColIdx] || '') : ''
            };
        }).filter(c => c.name);

    } catch (err) {
        console.error('Failed to load Companies List:', err);
        companiesData = null;
        alert('Unable to load the Companies List dropdown.\n\n' + err.message);
    }
}

function populateCompanySelect(selectElement) {
    if (!selectElement) return;
    const previousValue = selectElement.value;
    selectElement.innerHTML = '';

    const blankOption = document.createElement('option');
    blankOption.value = '';
    blankOption.textContent = companiesData ? '-- Select Company --' : '-- Unable to load Companies List --';
    selectElement.appendChild(blankOption);

    if (companiesData) {
        companiesData.forEach(c => {
            const opt = document.createElement('option');
            const concatenatedVal = c.id + ' - ' + c.name;
            opt.value = concatenatedVal;
            opt.dataset.companyId = c.id;
            opt.dataset.voltageLevel = c.voltage || '';
            opt.textContent = concatenatedVal;
            selectElement.appendChild(opt);
        });
    }

    if (previousValue) {
        selectElement.value = previousValue;
    }
}

function triggerSequenceVerificationPrompt(event) {
    const dialogText = "Please make sure the file you will be uploading here is a merged file of the following IN SEQUENCE:\n\n" +
                       "1) Previous Approval Form(if available). IMPORTANT!!!: INCLUDE PREVIOUSLY DOWNGRADED APPROVAL IF ENGINEER WAS PREVIOUSLY DOWNGRADED.\n" +
                       "2) Iqama or ID\n" +
                       "3) Muqeem Information\n" +
                       "4) Engineer's CV(should be stamped, updated and brief)\n" +
                       "5) PD Certificate from the PD measuring unit manufacturer(see PD certificate conditions)\n" +
                       "6) Engineering Accreditation certifications from Saudi council of Engineers(the specialization must be shown) + barcode\n" +
                       "7) GOSI(showing your company's name as an employer - for Saudis only)+barcode.";
    alert(dialogText);
}

function applySelectColor(select) {
    const parentCell = select.closest('.qual-cell');
    if (!parentCell) return;
    
    if (select.value === 'YES') {
        parentCell.className = 'qual-cell cell-yes';
    } else if (select.value === 'NO') {
        parentCell.className = 'qual-cell cell-no';
    } else {
        parentCell.className = 'qual-cell';
    }
}

function validateDropdownRules(select) {
    const record = select.closest('.engineer-record');
    if (!record) return true;

    const ksaYrs = parseInt(record.querySelector('[name="profile_ksa_exp_yrs[]"]').value) || 0;
    const totalYrs = parseInt(record.querySelector('[name="profile_total_exp_yrs[]"]').value) || 0;

    if (select.name === 'q_live_substations[]' && select.value === 'YES') {
        if (ksaYrs < 1) {
            alert("Validation Error:\n'Live Substations' can only be marked as YES if Experience in KSA is 1 year or greater.");
            return false;
        }
    }

    if ((select.name === 'q_coordinator_hv[]' || select.name === 'q_coordinator_ehv[]') && select.value === 'YES') {
        if (totalYrs < 7 || ksaYrs < 2) {
            alert("Validation Error:\n'Site Coordinator' can only be marked as YES if Total Experience is 7 years or greater AND Experience in KSA is 2 years or greater.");
            return false;
        }
    }
    return true;
}

function initSelectColors(context) {
    const dropdowns = context.querySelectorAll('.qual-select');
    dropdowns.forEach(select => {
        applySelectColor(select);
        select.addEventListener('change', function() {
            // Instantly revert to NO if validation fails during selection
            if (!validateDropdownRules(this)) {
                this.value = 'NO';
            }
            applySelectColor(this);
            saveFormState();
        });
    });
}

function handleFileChange(inputElement) {
    const badge = inputElement.nextElementSibling;
    if (inputElement.files && inputElement.files.length > 0) {
        const file = inputElement.files[0];
        const maxSizeBytes = 1.3 * 1024 * 1024; // 1.3MB validation rule
        
        if (file.size > maxSizeBytes) {
            alert("Validation Error: The attached credentials file exceeds the maximum allowed size of 1.3MB. Please attach a smaller file.");
            inputElement.value = ""; // Clear the selected file
            badge.style.display = 'none';
            return;
        }
        
        badge.style.display = 'inline';
    } else {
        badge.style.display = 'none';
    }
}

function syncRecordHeights(record) {
    if (!record) return;
    const profileTable = record.querySelector('.profile-table');
    const qualWrapper = record.querySelector('.qualifications-layout-wrapper');
    if (!profileTable || !qualWrapper) return;

    profileTable.style.height = 'auto';
    qualWrapper.style.height = 'auto';

    const profileHeight = profileTable.getBoundingClientRect().height;
    const qualHeight = qualWrapper.getBoundingClientRect().height;
    const targetHeight = Math.max(profileHeight, qualHeight);

    profileTable.style.height = targetHeight + 'px';
    qualWrapper.style.height = targetHeight + 'px';
}

function syncAllRecordHeights() {
    document.querySelectorAll('#engineers-container .engineer-record').forEach(syncRecordHeights);
}

const MAX_ENGINEERS = 10;

function addNewEngineer(savedData = null) {
    const container = document.getElementById('engineers-container');
    const currentCount = container.querySelectorAll('.engineer-record').length;

    if (currentCount >= MAX_ENGINEERS) {
        if (!savedData) {
            alert(`You can record a maximum of ${MAX_ENGINEERS} engineers per submission.`);
        }
        updateRemoveButtonsVisibility();
        return;
    }

    const templateNode = document.querySelector('#record-template .engineer-record');
    const newRecord = templateNode.cloneNode(true);

    if (savedData) {
        newRecord.querySelectorAll('input[type="text"], textarea').forEach((el, index) => {
            if (savedData.texts && savedData.texts[index] !== undefined) el.value = savedData.texts[index];
        });
        newRecord.querySelectorAll('select').forEach((el, index) => {
            if (savedData.selects && savedData.selects[index] !== undefined) el.value = savedData.selects[index];
        });
    }

    initSelectColors(newRecord);
    container.appendChild(newRecord);
    
    updateRemoveButtonsVisibility();
    requestAnimationFrame(() => syncRecordHeights(newRecord));
    if (!savedData) saveFormState();
}

function removeEngineerRecord(button) {
    const record = button.closest('.engineer-record');
    if (record) {
        record.remove();
        updateRemoveButtonsVisibility();
        saveFormState();
    }
}

function updateRemoveButtonsVisibility() {
    const records = document.querySelectorAll('#engineers-container .engineer-record');
    records.forEach(record => {
        const btn = record.querySelector('.btn-remove-record');
        if (btn) {
            btn.style.display = records.length > 1 ? 'block' : 'none';
        }
    });

    const addBtn = document.getElementById('btn-add-engineer');
    if (addBtn) {
        const atLimit = records.length >= MAX_ENGINEERS;
        addBtn.disabled = atLimit;
        addBtn.style.opacity = atLimit ? '0.6' : '1';
        addBtn.style.cursor = atLimit ? 'not-allowed' : 'pointer';
        addBtn.title = atLimit ? `Maximum of ${MAX_ENGINEERS} engineers reached` : '';
    }
}

function saveFormState() {
    const records = document.querySelectorAll('#engineers-container .engineer-record');
    const state = [];

    records.forEach(record => {
        const texts = [];
        const selects = [];
        
        record.querySelectorAll('input[type="text"], textarea').forEach(el => texts.push(el.value));
        record.querySelectorAll('select').forEach(el => selects.push(el.value));
        
        state.push({ texts, selects });
    });

    const globalState = {
        company: document.getElementById('global_company').value,
        region: document.getElementById('global_region').value,
        records: state,
        savedAt: Date.now() // used to auto-expire this PII from localStorage — see loadFormState()
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(globalState));
}

function loadFormState() {
    const container = document.getElementById('engineers-container');
    container.innerHTML = ''; 
    
    const rawState = localStorage.getItem(STORAGE_KEY);
    if (rawState) {
        try {
            const parsedState = JSON.parse(rawState);

            const savedAt = parsedState.savedAt || 0;
            const isExpired = (Date.now() - savedAt) > STORAGE_TTL_MS;

            if (isExpired) {
                // Data is stale — wipe it rather than restoring old personal information into the form.
                localStorage.removeItem(STORAGE_KEY);
                addNewEngineer();
                return;
            }

            if (parsedState.company !== undefined) document.getElementById('global_company').value = parsedState.company;
            if (parsedState.region !== undefined) document.getElementById('global_region').value = parsedState.region;

            if (parsedState && parsedState.records && parsedState.records.length > 0) {
                parsedState.records.forEach(recordData => addNewEngineer(recordData));
                return;
            }
        } catch (e) {
            console.error("Failed to parse local form persistence state", e);
            localStorage.removeItem(STORAGE_KEY);
        }
    }
    addNewEngineer();
}

function confirmResetForm() {
    const message = "Are you sure you want to completely clear the rows and reset the entry form?\nAll unsubmitted input details will be lost permanently.";
    if (confirm(message)) {
        localStorage.removeItem(STORAGE_KEY);
        document.getElementById('global_company').value = "";
        document.getElementById('global_region').value = "";
        loadFormState();
    }
}

async function getPopulatedPDFBytes(data, companyName, templateBytes) {
    const pdfDoc = await PDFLib.PDFDocument.load(templateBytes);
    const form = pdfDoc.getForm();
    const firstPage = pdfDoc.getPages()[0];

    // 1. Safely embed Helvetica-Bold
    let customFont = null;
    try {
        customFont = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    } catch (err) {
        console.warn('Could not embed HelveticaBold:', err);
    }

    const normalizeValue = (value) => (value ?? '').toString().trim();
    const conditionalContextValue = (value) => normalizeValue(value).toUpperCase() === 'NO' ? 'NO' : '';

    // Helper for Contractor (primary) fields
    const safeSetPrimaryText = (fieldName, value) => {
        try {
            const field = form.getTextField(fieldName);
            if (field) {
                field.setText(value || '');
                if (customFont) {
                    try {
                        field.updateAppearances(customFont);
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.warn(`Text fill skipped for: "${fieldName}"`);
        }
    };

    // Helper for CSD Approval fields (Font size 13, Red for NO, Blue highlight for blank)
    const safeSetContextField = (fieldName, rawValue) => {
        try {
            const field = form.getTextField(fieldName);
            if (!field) return;

            const finalVal = conditionalContextValue(rawValue);
            field.setText(finalVal);
            field.setFontSize(13);

            const fontName = customFont ? customFont.name : 'Helvetica-Bold';
            const isNo = finalVal.toUpperCase() === 'NO';

            // Set Red text if NO, Black if other
            const colorOperator = isNo ? '1 0 0 rg' : '0 0 0 rg';
            try {
                field.acroField.dict.set(
                    PDFLib.PDFName.of('DA'),
                    PDFLib.PDFString.of(`/${fontName} 13 Tf ${colorOperator}`)
                );
            } catch (e) {}

            if (customFont) {
                try {
                    field.updateAppearances(customFont);
                } catch (e) {}
            }

            // Draw 75% transparent blue highlight on blank CSD fields
            if (finalVal === '') {
                const widgets = field.acroField.getWidgets();
                widgets.forEach(widget => {
                    const rect = widget.getRectangle();
                    firstPage.drawRectangle({
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        color: PDFLib.rgb(0.2, 0.5, 1.0), // Blue
                        opacity: 0.25                     // 75% transparency
                    });
                });
            }
        } catch (e) {
            console.warn(`Context field update skipped for: "${fieldName}"`);
        }
    };

    // Populate Contractor Column
    const primaryFieldMap = {
        txtengrname: data.name,
        txtnationality: data.nationality,
        txtidentityno: data.identity,
        txtcompanyname: companyName,
        txttotalexpyr: data.total_yrs,
        txttotalexpmo: data.total_mos,
        txtexpksayr: data.ksa_yrs,
        txtexpksamo: data.ksa_mos,
        txtmobileno: data.contact
    };

    Object.entries(primaryFieldMap).forEach(([fieldName, value]) => {
        safeSetPrimaryText(fieldName, value);
    });

    data.matrix.forEach(item => safeSetPrimaryText(item.pdfField, item.value));

    // Populate CSD Approval Column
    const contextFieldMap = {
        ctxtengrname: data.name,
        ctxtnationality: data.nationality,
        ctxtidentityno: data.identity,
        ctxtcompanyname: companyName,
        ctxttotalexpyr: data.total_yrs,
        ctxttotalexpmo: data.total_mos,
        ctxtexpksayr: data.ksa_yrs,
        ctxtexpksamo: data.ksa_mos,
        ctxtmobileno: data.contact 
    };

    data.matrix.forEach(item => contextFieldMap[`c${item.pdfField}`] = item.value);

    Object.entries(contextFieldMap).forEach(([fieldName, value]) => {
        safeSetContextField(fieldName, value);
    });

    // Make filled/contractor fields read-only while keeping blank CSD fields editable
    form.getFields().forEach(field => {
        const fieldName = field.getName();
        const isContextField = fieldName.startsWith('ctxt');
        let shouldStayEditable = false;

        if (isContextField) {
            try {
                const textField = form.getTextField(fieldName);
                shouldStayEditable = normalizeValue(textField.getText()) === '';
            } catch (e) {
                shouldStayEditable = false;
            }
        }

        if (!shouldStayEditable && typeof field.enableReadOnly === 'function') {
            field.enableReadOnly();
        }
    });

    return await pdfDoc.save();
}

function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

function validateRequiredYellowFields(records) {
    const companyEl = document.getElementById('global_company');
    const regionEl = document.getElementById('global_region');
    
    if (!companyEl.value) {
        alert("Please select a Company Name from the header block.");
        companyEl.focus();
        return false;
    }
    if (!regionEl.value) {
        alert("Please select a Region from the header block.");
        regionEl.focus();
        return false;
    }

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const recordNum = i + 1;

        const fieldsToCheck = [
            { selector: '[name="profile_name[]"]', label: "Engineer's Name" },
            { selector: '[name="profile_nationality[]"]', label: 'Nationality' },
            { selector: '[name="profile_total_exp_yrs[]"]', label: 'Total Experience (Yrs)' },
            { selector: '[name="profile_total_exp_mos[]"]', label: 'Total Experience (Mos)' },
            { selector: '[name="profile_ksa_exp_yrs[]"]', label: 'Experience in KSA (Yrs)' },
            { selector: '[name="profile_ksa_exp_mos[]"]', label: 'Experience in KSA (Mos)' }
        ];

        for (const field of fieldsToCheck) {
            const el = record.querySelector(field.selector);
            if (!el || el.value.toString().trim() === '') {
                alert(`Engineer Record #${recordNum}: Please fill up the required "${field.label}" field before submitting.`);
                if (el) el.focus();
                return false;
            }
        }

        // --- NEW EXPERIENCE VALIDATION ---
        const totalYrs = parseInt(record.querySelector('[name="profile_total_exp_yrs[]"]').value) || 0;
        const totalMos = parseInt(record.querySelector('[name="profile_total_exp_mos[]"]').value) || 0;
        const ksaYrs = parseInt(record.querySelector('[name="profile_ksa_exp_yrs[]"]').value) || 0;
        const ksaMos = parseInt(record.querySelector('[name="profile_ksa_exp_mos[]"]').value) || 0;

        const totalExpMonths = (totalYrs * 12) + totalMos;
        const ksaExpMonths = (ksaYrs * 12) + ksaMos;

        if (ksaExpMonths > totalExpMonths) {
            alert(`Engineer Record #${recordNum}:\nCombined Experience in KSA (${ksaYrs} Yrs, ${ksaMos} Mos) cannot be greater than the Combined Total Experience (${totalYrs} Yrs, ${totalMos} Mos).`);
            return false;
        }

        // --- DOUBLE CHECK DROPDOWN CONDITIONS BEFORE SUBMITTING ---
        const liveSub = record.querySelector('[name="q_live_substations[]"]').value;
        if (liveSub === 'YES' && ksaYrs < 1) {
            alert(`Engineer Record #${recordNum}:\n'Live Substations' is marked YES, but Experience in KSA is less than 1 year.`);
            return false;
        }

        const coordHV = record.querySelector('[name="q_coordinator_hv[]"]').value;
        const coordEHV = record.querySelector('[name="q_coordinator_ehv[]"]').value;
        if ((coordHV === 'YES' || coordEHV === 'YES') && (totalYrs < 7 || ksaYrs < 2)) {
            alert(`Engineer Record #${recordNum}:\n'Site Coordinator' is marked YES, but requires Total Experience >= 7 years and Experience in KSA >= 2 years.`);
            return false;
        }

        const identityEl = record.querySelector('[name="profile_identity[]"]');
        if (!identityEl || !/^\d{10}$/.test(identityEl.value)) {
            alert(`Engineer Record #${recordNum}: Please enter exactly 10 digits for the Iqama/ID.`);
            if (identityEl) identityEl.focus();
            return false;
        }

        const contactEl = record.querySelector('[name="profile_contact[]"]');
        if (!contactEl || !/^\d{10}$/.test(contactEl.value)) {
            alert(`Engineer Record #${recordNum}: Please enter exactly 10 digits for the Contact No.`);
            if (contactEl) contactEl.focus();
            return false;
        }

        const credentialsInput = record.querySelector('[name="profile_credentials[]"]');
        if (!credentialsInput || !credentialsInput.files || credentialsInput.files.length === 0) {
            alert(`Engineer Record #${recordNum}: Please attach the required "Credentials Attachment" file before submitting.`);
            return false;
        }
    }
    return true;
}

async function handleFormSubmission(event, skipEml = false) {
    event.preventDefault();

    const records = document.querySelectorAll('#engineers-container .engineer-record');
    if (records.length === 0) return;

    if (!validateRequiredYellowFields(records)) {
        return;
    }

    setGeneratingState(true);
    updateGenerationStatus('Preparing template...', 2);

    const individualPdfAttachments = [];
    const totalSteps = records.length + 1; // +1 for the final wrap-up step
    let completedSteps = 0;

    try {
        const response = await fetch('prequalform.pdf');
        if (!response.ok) {
            throw new Error('Could not read backend prequalform.pdf template file.');
        }
        const templateBytes = await response.arrayBuffer();
        
        const globalCompanySelect = document.getElementById('global_company');
        const companyNameVal = globalCompanySelect.value;
        const companyIdVal = globalCompanySelect.options[globalCompanySelect.selectedIndex].dataset.companyId || 'nocompanyid';
        const regionVal = document.getElementById('global_region').value;
        const safeRegionVal = (regionVal || 'noregion').replace(/[^a-z0-9]/gi, '_');
        const dateStrForFileName = getDateDDMMMYY();

        let engineerIndex = 0;
        for (let record of records) {
            engineerIndex++;
            const engineerLabel = record.querySelector('[name="profile_name[]"]').value.trim() || `Engineer ${engineerIndex}`;
            updateGenerationStatus(
                `Filling form for ${engineerLabel} (${engineerIndex}/${records.length})...`,
                (completedSteps / totalSteps) * 100
            );
            const credentialsInput = record.querySelector('[name="profile_credentials[]"]');

            const engData = {
                name: record.querySelector('[name="profile_name[]"]').value,
                nationality: record.querySelector('[name="profile_nationality[]"]').value,
                identity: record.querySelector('[name="profile_identity[]"]').value,
                total_yrs: record.querySelector('[name="profile_total_exp_yrs[]"]').value,
                total_mos: record.querySelector('[name="profile_total_exp_mos[]"]').value,
                ksa_yrs: record.querySelector('[name="profile_ksa_exp_yrs[]"]').value,
                ksa_mos: record.querySelector('[name="profile_ksa_exp_mos[]"]').value,
                contact: record.querySelector('[name="profile_contact[]"]').value,
                status: record.querySelector('[name="profile_status[]"]').value,
                region: regionVal,
                location: record.querySelector('[name="profile_location[]"]').value,
                remarks: record.querySelector('[name="profile_remarks[]"]').value,
                matrix: [
                    { pdfField: "txtbattcharger", value: record.querySelector('[name="q_batteries[]"]').value },
                    { pdfField: "txtacdbdcdb", value: record.querySelector('[name="q_acdb_dcdb[]"]').value },
                    { pdfField: "txtauxtriprelaysmccb", value: record.querySelector('[name="q_aux_relays[]"]').value },
                    { pdfField: "txtmeters", value: record.querySelector('[name="q_meters[]"]').value },
                    { pdfField: "txtxfrmrmv", value: record.querySelector('[name="q_tx_mv[]"]').value },
                    { pdfField: "txtxfrmrhv", value: record.querySelector('[name="q_tx_hv[]"]').value },
                    { pdfField: "txtxfrmrehv", value: record.querySelector('[name="q_tx_ehv[]"]').value },
                    { pdfField: "txtshuntmv", value: record.querySelector('[name="q_reactor_mv[]"]').value },
                    { pdfField: "txtshunthv", value: record.querySelector('[name="q_reactor_hv[]"]').value },
                    { pdfField: "txtshuntehv", value: record.querySelector('[name="q_reactor_ehv[]"]').value },
                    { pdfField: "txtcapmv", value: record.querySelector('[name="q_capacitor_mv[]"]').value },
                    { pdfField: "txtcaphv", value: record.querySelector('[name="q_capacitor_hv[]"]').value },
                    { pdfField: "txtcapehv", value: record.querySelector('[name="q_capacitor_ehv[]"]').value },
                    { pdfField: "txtohtl", value: record.querySelector('[name="q_ohtl[]"]').value },
                    { pdfField: "txtcableelecmv", value: record.querySelector('[name="q_cable_elec_mv[]"]').value },
                    { pdfField: "txtcableelechv", value: record.querySelector('[name="q_cable_elec_hv[]"]').value },
                    { pdfField: "txtcableelecehv", value: record.querySelector('[name="q_cable_elec_ehv[]"]').value },
                    { pdfField: "txtcablehvmv", value: record.querySelector('[name="q_cable_hv_mv[]"]').value },
                    { pdfField: "txtcablehvhv", value: record.querySelector('[name="q_cable_hv_hv[]"]').value },
                    { pdfField: "txtcablehvehv", value: record.querySelector('[name="q_cable_hv_ehv[]"]').value },
                    { pdfField: "txtcablepdmv", value: record.querySelector('[name="q_cable_pd_mv[]"]').value },
                    { pdfField: "txtcablepdhv", value: record.querySelector('[name="q_cable_pd_hv[]"]').value },
                    { pdfField: "txtcablepdehv", value: record.querySelector('[name="q_cable_pd_ehv[]"]').value },
                    { pdfField: "txtswgrmv", value: record.querySelector('[name="q_sg_eq_mv[]"]').value },
                    { pdfField: "txtswgrhv", value: record.querySelector('[name="q_sg_eq_hv[]"]').value },
                    { pdfField: "txtswgrehv", value: record.querySelector('[name="q_sg_eq_ehv[]"]').value },
                    { pdfField: "txtswgrhvmv", value: record.querySelector('[name="q_sg_hv_mv[]"]').value },
                    { pdfField: "txtswgrhvhv", value: record.querySelector('[name="q_sg_hv_hv[]"]').value },
                    { pdfField: "txtswgrhvehv", value: record.querySelector('[name="q_sg_hv_ehv[]"]').value },
                    { pdfField: "txtswgrpdmv", value: record.querySelector('[name="q_sg_pd_mv[]"]').value },
                    { pdfField: "txtswgrpdhv", value: record.querySelector('[name="q_sg_pd_hv[]"]').value },
                    { pdfField: "txtswgrpdehv", value: record.querySelector('[name="q_sg_pd_ehv[]"]').value },
                    { pdfField: "txtschememv", value: record.querySelector('[name="q_scheme_mv[]"]').value },
                    { pdfField: "txtschemehv", value: record.querySelector('[name="q_scheme_hv[]"]').value },
                    { pdfField: "txtschemeehv", value: record.querySelector('[name="q_scheme_ehv[]"]').value },
                    { pdfField: "txtctmv", value: record.querySelector('[name="q_ct_mv[]"]').value },
                    { pdfField: "txtcthv", value: record.querySelector('[name="q_ct_hv[]"]').value },
                    { pdfField: "txtctehv", value: record.querySelector('[name="q_ct_ehv[]"]').value },
                    { pdfField: "txtvtsecmv", value: record.querySelector('[name="q_vt_mv[]"]').value },
                    { pdfField: "txtvtsechv", value: record.querySelector('[name="q_vt_hv[]"]').value },
                    { pdfField: "txtvtsecehv", value: record.querySelector('[name="q_vt_ehv[]"]').value },
                    { pdfField: "txtsimplerelaysmv", value: record.querySelector('[name="q_simple_relay_mv[]"]').value },
                    { pdfField: "txtsimplerelayshv", value: record.querySelector('[name="q_simple_relay_hv[]"]').value },
                    { pdfField: "txtsimplerelaysehv", value: record.querySelector('[name="q_simple_relay_ehv[]"]').value },
                    { pdfField: "txtadvancedprotmv", value: record.querySelector('[name="q_adv_ied_mv[]"]').value },
                    { pdfField: "txtadvancedprothv", value: record.querySelector('[name="q_adv_ied_hv[]"]').value },
                    { pdfField: "txtadvancedprotehv", value: record.querySelector('[name="q_adv_ied_ehv[]"]').value },
                    { pdfField: "txtstabmv", value: record.querySelector('[name="q_stability_mv[]"]').value },
                    { pdfField: "txtstabhv", value: record.querySelector('[name="q_stability_hv[]"]').value },
                    { pdfField: "txtstabehv", value: record.querySelector('[name="q_stability_ehv[]"]').value },
                    { pdfField: "txtendtoendhv", value: record.querySelector('[name="q_e2e_hv[]"]').value },
                    { pdfField: "txtendtoendehv", value: record.querySelector('[name="q_e2e_ehv[]"]').value },
                    { pdfField: "txtfttmv", value: record.querySelector('[name="q_trip_mv[]"]').value },
                    { pdfField: "txtftthv", value: record.querySelector('[name="q_trip_hv[]"]').value },
                    { pdfField: "txtfttehv", value: record.querySelector('[name="q_trip_ehv[]"]').value },
                    { pdfField: "txtlivess", value: record.querySelector('[name="q_live_substations[]"]').value },
                    { pdfField: "txtschv", value: record.querySelector('[name="q_coordinator_hv[]"]').value },
                    { pdfField: "txtscehv", value: record.querySelector('[name="q_coordinator_ehv[]"]').value }
                ]
            };

            const populatedBytes = await getPopulatedPDFBytes(engData, companyNameVal, templateBytes);
            const mergedPdf = await PDFLib.PDFDocument.create();
            const sourceFormPdf = await PDFLib.PDFDocument.load(populatedBytes);
            
            const formPages = await mergedPdf.copyPages(sourceFormPdf, sourceFormPdf.getPageIndices());
            formPages.forEach(p => mergedPdf.addPage(p));

            if (credentialsInput && credentialsInput.files.length > 0) {
                const originalCredFile = credentialsInput.files[0];

                updateGenerationStatus(
                    `Merging attachment for ${engineerLabel} (${engineerIndex}/${records.length})...`,
                    (completedSteps / totalSteps) * 100
                );

                try {
                    const credentialsBytes = await originalCredFile.arrayBuffer();
                    const credentialsDoc = await PDFLib.PDFDocument.load(credentialsBytes);
                    const credentialsPages = await mergedPdf.copyPages(credentialsDoc, credentialsDoc.getPageIndices());
                    credentialsPages.forEach(p => mergedPdf.addPage(p));
                } catch (err) {
                    console.error(`Failed to merge credentials attachment for ${engData.name}:`, err);
                    throw new Error(
                        `Engineer Record for "${engineerLabel}": the attached credentials file "${originalCredFile.name}" ` +
                        `could not be read as a valid PDF (it may be corrupted, password-protected, or not actually a PDF). ` +
                        `Please re-check and re-upload it, then try again. No files were sent.`
                    );
                }
            }

            updateGenerationStatus(
                `Building PDF for ${engineerLabel} (${engineerIndex}/${records.length})...`,
                (completedSteps / totalSteps) * 100
            );

            const finalPdfBytes = await mergedPdf.save();
            
            const safeIqama = (engData.identity || 'noiqama').replace(/[^a-z0-9]/gi, '_');
            const safeCompanyId = (companyIdVal || 'nocompanyid').replace(/[^a-z0-9]/gi, '_');
            const pdfFileName = `intreq${safeRegionVal}_${safeCompanyId}_${safeIqama}_${dateStrForFileName}.pdf`;

            downloadBytesAsFile(finalPdfBytes, pdfFileName);

            individualPdfAttachments.push({
                fileName: pdfFileName,
                mimeType: "application/pdf",
                base64: uint8ArrayToBase64(finalPdfBytes)
            });

            completedSteps++;
        }

        completedSteps++;
        updateGenerationStatus('Finishing up...', 100);

        if (!skipEml) {
            updateGenerationStatus('Creating email draft...', 100);
            const tableHeaders = ["SN", "Name", "Status", "Region", "Location", "Remarks"];

            let emailHtmlStr = `<p>Dear,</p><p>Good day. This is to kindly request for the approval interviews of the following Engineers available in ${escapeHtml(regionVal)}:</p>`;
            emailHtmlStr += `<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;border:1px solid #000;font-family:Arial,sans-serif;font-size:13px;">`;
            emailHtmlStr += `<thead><tr>`;
            tableHeaders.forEach(h => {
                emailHtmlStr += `<th style="border:1px solid #000;background-color:#ffff00;font-weight:bold;padding:6px;">${h}</th>`;
            });
            emailHtmlStr += `</tr></thead><tbody>`;

            records.forEach((record, idx) => {
                const name = record.querySelector('[name="profile_name[]"]').value.replace(/\n/g, ' ');
                const status = record.querySelector('[name="profile_status[]"]').value;
                const loc = record.querySelector('[name="profile_location[]"]').value;
                const rem = record.querySelector('[name="profile_remarks[]"]').value;

                emailHtmlStr += `<tr>`;
                [idx + 1, name, status, regionVal, loc, rem].forEach(cellVal => {
                    emailHtmlStr += `<td style="border:1px solid #000;padding:6px;">${escapeHtml(cellVal)}</td>`;
                });
                emailHtmlStr += `</tr>`;
            });

            emailHtmlStr += `</tbody></table><p>Attached above are the related documents for each of the engineers in the list. FYA and Best Regards</p>`;

            const detailedTimestamp = getDetailedTimestamp();
            const emailSubjectStr = `${companyIdVal || ''} - for CSD Approval Interview requests_SN${detailedTimestamp}`;
            const emlDownloadName = `draftmail_${(companyIdVal || 'nocompanyid').replace(/[^a-z0-9]/gi, '_')}_${getDetailedTimestampDDMMMYY()}.eml`;

            let emlGenerationSucceeded = false;
            let totalAttachmentBytes = 0;
            try {
                totalAttachmentBytes = individualPdfAttachments.reduce(
                    (sum, att) => sum + Math.ceil(att.base64.length * 0.75), 0
                );
                downloadEmlWithAttachments(emailSubjectStr, emailHtmlStr, individualPdfAttachments, emlDownloadName);
                emlGenerationSucceeded = true;
            } catch (emlErr) {
                console.error("Failed to generate .eml draft with attachments:", emlErr);
            }

            const sizeWarningThresholdBytes = 20 * 1024 * 1024;
            const sizeWarningNote = totalAttachmentBytes > sizeWarningThresholdBytes
                ? `\n\n⚠ Combined, the ${individualPdfAttachments.length} attached PDF(s) total roughly ${(totalAttachmentBytes / (1024 * 1024)).toFixed(1)} MB. Many mail servers (Outlook/Exchange ~20-25MB, Gmail ~25MB) will reject or strip an email over that size — if sending fails, use the downloaded PDF files instead.`
                : "";

            const emlNote = emlGenerationSucceeded
                ? `An .eml draft file "${emlDownloadName}" was downloaded, with all ${individualPdfAttachments.length} generated PDF(s) attached individually. It is a ready-to-send draft, so you only need to add a recipient and hit Send. It must be opened with Outlook(classic) provided that you already have a microsoft exchange account(setup by your Company IT admin). (Outlook on Mac and Outlook on the web may not open it the same way.)${sizeWarningNote}`
                : "The .eml draft could not be generated this time — check the browser console for details.";

            alert(`All ${individualPdfAttachments.length} PDF form(s) have been downloaded to your default Downloads folder.\n\n${emlNote}`);
        } else {
            alert(`All ${individualPdfAttachments.length} PDF form(s) have been downloaded to your default Downloads folder.`);
        }

        localStorage.removeItem(STORAGE_KEY);

    } catch (globalFaultException) {
        console.error("Batch processing operation failure parameters:", globalFaultException);
        const userFacingMessage = (globalFaultException && globalFaultException.message)
            ? globalFaultException.message
            : "An error occurred during multi-record compilation execution pipelines. Check browser workspace log.";
        alert(userFacingMessage);
    } finally {
        setGeneratingState(false);
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    await initPdfWorkerWithIntegrity();
    await loadCompaniesList();
    populateCompanySelect(document.getElementById('global_company'));
    loadFormState();
    requestAnimationFrame(syncAllRecordHeights);
});

let resizeSyncTimer = null;
window.addEventListener('resize', function() {
    clearTimeout(resizeSyncTimer);
    resizeSyncTimer = setTimeout(syncAllRecordHeights, 150);
});
