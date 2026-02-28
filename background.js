// background.js

function setupPdfRedirectRule() {
    const ruleId = 1;
    const extensionId = chrome.runtime.id;
    // We use \0 to pass the entire matched URL as a query parameter.
    // We use regexSubstitution to retain the matched elements.
    const viewerUrl = `chrome-extension://${extensionId}/viewer.html?url=\\0`;

    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId],
        addRules: [{
            id: ruleId,
            priority: 1,
            action: {
                type: 'redirect',
                redirect: {
                    regexSubstitution: viewerUrl
                }
            },
            condition: {
                // Match http/https/ftp/file links ending in .pdf
                regexFilter: '^([^/]+)://.*\\.pdf.*$',
                resourceTypes: ['main_frame', 'sub_frame']
            }
        }]
    }).then(() => console.log('Dynamic PDF interception rule added.'));
}

chrome.runtime.onInstalled.addListener(() => {
    console.log("PDF Viewer Extension installed.");
    setupPdfRedirectRule();
});

// Since the service worker can be inactive, adding onStartup as a precaution.
chrome.runtime.onStartup.addListener(() => {
    setupPdfRedirectRule();
});

// Run immediately upon loading to ensure the rule is applied right away.
setupPdfRedirectRule();
