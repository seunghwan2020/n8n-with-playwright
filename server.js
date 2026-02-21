const express = require('express');
const app = express();
app.use(express.json());

// 분리된 쇼핑몰 파일들 불러오기
const handle11st = require('./scrapers/11st');
const handleEzadmin = require('./scrapers/ezadmin');

app.post('/execute', async (req, res) => {
    const { action, target = '11st' } = req.body;

    try {
        // target에 따라 담당 파일로 연결 (라우팅)
        if (target === '11st') {
            return await handle11st(req, res, action);
        } 
        else if (target === 'ezadmin') {
            return await handleEzadmin(req, res, action);
        } 
        else {
            return res.status(400).json({ status: 'ERROR', message: '알 수 없는 타겟입니다.' });
        }
    } catch (error) {
        console.error(`📍 [서버 전체 에러]`, error);
        res.status(500).json({ status: 'ERROR', message: error.message });
    }
});

app.listen(8080, () => console.log('Playwright Routing Server running on :8080'));
