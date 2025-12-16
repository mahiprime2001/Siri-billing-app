
import packageInfo from '../package.json';

const VersionDisplay = () => {
  return (
    <div className="fixed bottom-4 right-4 text-xs text-gray-500">
      v{packageInfo.version}
    </div>
  );
};

export default VersionDisplay;
