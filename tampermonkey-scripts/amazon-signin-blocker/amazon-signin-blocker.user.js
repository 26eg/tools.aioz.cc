// ==UserScript==
// @name         Amazon Sign-in Blocker
// @namespace    https://github.com/26eg/tools.aioz.cc
// @version      1.1.0
// @description  拦截亚马逊登录页面：检测到登录相关页面时立即停止加载并显示提示。
// @author       26eg
// @homepageURL  https://tools.aioz.cc/tampermonkey-scripts/
// @updateURL    https://tools.aioz.cc/tampermonkey-scripts/amazon-signin-blocker/amazon-signin-blocker.user.js
// @downloadURL  https://tools.aioz.cc/tampermonkey-scripts/amazon-signin-blocker/amazon-signin-blocker.user.js
// @match        *://*.amazon.com/*
// @match        *://*.amazon.ca/*
// @match        *://*.amazon.com.mx/*
// @match        *://*.amazon.com.br/*
// @match        *://*.amazon.co.uk/*
// @match        *://*.amazon.de/*
// @match        *://*.amazon.fr/*
// @match        *://*.amazon.it/*
// @match        *://*.amazon.es/*
// @match        *://*.amazon.cn/*
// @match        *://*.amazon.in/*
// @match        *://*.amazon.co.jp/*
// @match        *://*.amazon.com.au/*
// @match        *://*.amazon.nl/*
// @match        *://*.amazon.se/*
// @match        *://*.amazon.pl/*
// @match        *://*.amazon.com.be/*
// @match        *://*.amazon.com.tr/*
// @match        *://*.amazon.ae/*
// @match        *://*.amazon.sa/*
// @match        *://*.amazon.eg/*
// @match        *://*.amazon.sg/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 检查URL路径是否包含 'signin' (不区分大小写)
    if (window.location.pathname.toLowerCase().includes('/signin')) {

        // 1. **[关键]** 立即停止页面加载
        window.stop();

        // 2. **[新增]** 获取当前亚马逊站点的首页地址，例如 "https://www.amazon.de"
        const homepageUrl = window.location.origin;

        // 3. **[新增]** 使用获取到的首页地址替换浏览器地址栏中难看的登录URL
        // 这会让用户体验更好，且不会在浏览器历史中留下登录页记录
        history.replaceState(null, '访问已拦截', homepageUrl);

        // 4. **[升级]** 清空页面并显示包含动态返回链接的自定义信息
        document.documentElement.innerHTML = `
            <head>
                <title>访问已拦截</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="margin:0; padding:0; background-color: #f0f2f5;">
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px 20px; color: #111;">
                    <h1 style="color: #c00; font-weight: 500;">不可以登录亚马逊相关网站哦~</h1>
                    <h2 style="color: #c00; font-weight: 500;">本次访问已被脚本拦截</h2>
                    <p style="font-size: 1.1em; margin-top: 15px;">原因：侦测到这是一个亚马逊登录相关页面。</p>
                    <p style="margin-top: 30px;">
                        <a href="${homepageUrl}" style="text-decoration: none; background-color: #007185; color: white; padding: 10px 20px; border-radius: 8px; font-size: 1em;">
                            返回 ${homepageUrl.replace('https://', '')} 首页
                        </a>
                    </p>
                </div>
            </body>
        `;
    }
})();