const express = require('express');
const app = express();
app.use(express.json());

// 🌟 각 사이트별 전담 모듈을 불러옵니다.
const handler11st = require('./11th.js');
// const handlerEasyAdmin = require('./easyadmin.js'); // 나중에 이지어드민을 추가할 때 주석을 풉니다.

app.post('/execute', async (req, res) => {
    // 🌟 이제 n8n에서 'site'라는 이름표도 같이 보내줘야 합니다.
    const { site, action } = req.body;

    if (!site) {
        return res.status(400).json({ status: 'ERROR', message: '어느 사이트인지 site 파라미터를 보내주세요. (예: 11st)' });
    }

    try {
        console.log(`\n🚀 [요청 수신] 타겟 사이트: ${site} / 액션: ${action}`);

        // 사이트 이름에 맞춰서 각 전담 파일로 업무를 넘깁니다.
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
