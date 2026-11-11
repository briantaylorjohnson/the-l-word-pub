import { Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';
import { ReportsList } from './ReportsList';
import { ReportDetail } from './ReportDetail';
import { AdminIngest } from './AdminIngest';

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<ReportsList />} />
        <Route path="/reports/:reportCode/:fightId" element={<ReportDetail />} />
        <Route path="/admin" element={<AdminIngest />} />
      </Route>
    </Routes>
  );
}

export default App;
