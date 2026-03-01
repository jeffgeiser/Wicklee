import React from 'react';

interface LogoProps {
  className?: string;
  active?: boolean;
}

const Logo: React.FC<LogoProps> = ({ className = "", active = false }) => {
  return (
    <div className={`flex items-center font-bold tracking-tight select-none ${className}`}>
      <span className="text-white">W</span>
      <span className="relative inline-block text-white">
        ı
        <div className="absolute top-[15%] left-1/2 -translate-x-1/2 flex items-center justify-center">
          {/* The Core Dot */}
          <div 
            className={`w-[0.32em] h-[0.32em] bg-cyan-400 rounded-full z-10 transition-all duration-500 ${active ? 'scale-110' : ''}`}
            style={{ 
              boxShadow: active 
                ? '0 0 8px 2px rgba(34, 211, 238, 0.8), 0 0 15px rgba(34, 211, 238, 0.4)' 
                : '0 0 4px 1px rgba(34, 211, 238, 0.4)' 
            }}
          ></div>
          
          {/* The Sentinel Pulse */}
          {active && (
            <>
              <div className="absolute w-[0.32em] h-[0.32em] bg-cyan-400 rounded-full animate-dramatic-pulse opacity-80"></div>
              <div className="absolute w-[0.32em] h-[0.32em] bg-cyan-400 rounded-full animate-dramatic-pulse opacity-40 [animation-delay:0.4s]"></div>
            </>
          )}
          
          {/* Subtle outer glow */}
          <div className={`absolute w-[0.8em] h-[0.8em] bg-cyan-400/20 rounded-full blur-md transition-all duration-500 ${active ? 'opacity-100 scale-150' : 'opacity-30'}`}></div>
        </div>
      </span>
      <span className="text-white">cklee</span>

      <style>{`
        @keyframes dramatic-pulse {
          0% { transform: scale(1); opacity: 0.8; }
          100% { transform: scale(2.8); opacity: 0; }
        }
        .animate-dramatic-pulse {
          animation: dramatic-pulse 2s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
      `}</style>
    </div>
  );
};

export default Logo;
