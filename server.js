const express = require('express');
const app = express();
app.use(express.json());

// 🌟 변경됨: scrapers 폴더 안에 있는 전담 모듈들을 불러옵니다.
const handler11st = require('./scrapers/11th.js');
// const handlerEasyAdmin = require('./scrapers/easyadmin.js'); // 나중에 주석 해제

app.post('/execute', async (req, res) => {
    const { site, action } = req.body;

    if (!site) {
        return res.status(400).json({ status: 'ERROR', message: '어느 사이트인지 site 파라미터를 보내주세요. (예: 11st)' });
    }

    try {
        console.log(`\n🚀 [요청 수신] 타겟 사이트: ${site} / 액션: ${action}`);

        // 사이트 이름표(site)에 맞춰서 scrapers 폴더 안의 각 파일로 업무를 넘깁니다.
        if (site === '11st') {
            await handler11st.execute(action, req, res);
        } 
        // else if (site === 'easyadmin') {
        //     await handlerEasyAdmin.execute(action, req, res);
        // }
        else {
            res.status(404).json({ status: 'ERROR', message: `아직 지원하지 않는 사이트입니다: ${site}` });
        }
    } catch (error) {
        console.error(`📍 [${site} 전역 에러]`, error);
        if (!res.headersSent) {
            res.status(500).json({ status: 'ERROR', message: error.message });
        }
    }
});

app.listen(8080, () => console.log('🚀 중앙 관제탑(Router) 서버가 8080 포트에서 실행 중입니다.'));
